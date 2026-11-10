import assert, {
  deepStrictEqual as assertEquals,
} from "node:assert/strict";
import { test } from "bun:test";
import { win32, join } from "node:path";
import { stat, unlink } from "node:fs/promises";

// Opt-in end-to-end check for the local downloader. It hands one real (small)
// file to the Quark app, waits for the transfer to finish, verifies the file
// landed on the host, then cancels the task and deletes its artifact.
//
// Run with: `QUARK_E2E=1 bun run test:e2e`. The app's Downloads
// directory is the `downloads/` bind mount, so the host path is derived from
// `QUARK_DOWNLOADS_HOST_DIR` (default `downloads`).

const enabled = process.env.QUARK_E2E === "1";
const apiUrl = process.env.QUARK_API_URL ?? process.env.CLIENT_URL ??
  "http://127.0.0.1:3000";
const hostDownloads = process.env.QUARK_DOWNLOADS_HOST_DIR ?? "downloads";

interface FileListItem {
  fid: string;
  name: string;
  dir: boolean;
  sizeBytes: number;
}

interface FileListResult {
  items: FileListItem[];
}

interface StartResult {
  fid: string;
  name: string;
  dir: boolean;
  directory: string;
  taskId: string;
}

interface LocalTask {
  taskId: string;
  name: string;
  status: string;
  progressPercent: number;
  sizeBytes: number | null;
  transferredBytes: number | null;
  path: string | null;
}

interface QueueResult {
  tasks: LocalTask[];
  counts: { total: number; finished: number; failed: number };
}

interface ControlResult {
  success: boolean;
  taskIds: string[];
  operation: string;
  removedPartials: string[];
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { Accept: "application/json" },
  });
  assertEquals(response.status, 200, `GET ${path} -> ${response.status}`);
  return await response.json() as T;
}

async function writeJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  assertEquals(response.status, 200, `${method} ${path} -> ${response.status}`);
  return await response.json() as T;
}

/** Smallest file reachable from the root, so the transfer finishes fast. */
async function findSmallestFile(): Promise<FileListItem | null> {
  const root = await getJson<FileListResult>("/files?fid=0");
  let best: FileListItem | null = null;
  const keep = (item: FileListItem) => {
    if (item.dir) return;
    if (!best || item.sizeBytes < best.sizeBytes) best = item;
  };
  root.items.forEach(keep);
  if (best) return best;
  for (const dir of root.items.filter((item) => item.dir)) {
    const listed = await getJson<FileListResult>(
      `/files?fid=${encodeURIComponent(dir.fid)}`,
    );
    listed.items.forEach(keep);
    if (best) return best;
  }
  return best;
}

test.skipIf(!enabled)(
  "download-file writes through the app's own downloader",
  async () => {
    const target = await findSmallestFile();
    assert(target, "no file available to download");

    const started = await writeJson<StartResult>("/downloads", {
      fid: target.fid,
    });
    assertEquals(started.fid, target.fid);
    assertEquals(started.dir, false);
    assert(started.taskId.length > 0, "startDownload returned no task id");
    assert(started.directory.length > 0, "startDownload returned no directory");

    let task: LocalTask | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      const queue = await getJson<QueueResult>(`/downloads?taskId=${encodeURIComponent(started.taskId)}`);
      task = queue.tasks.find((entry) => entry.taskId === started.taskId);
      if (task && (task.status === "finish" || task.status === "error")) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(task, "the started task never appeared in /downloads");
    assertEquals(task.status, "finish");
    assertEquals(task.progressPercent, 100);
    assertEquals(task.sizeBytes, target.sizeBytes);
    assertEquals(task.transferredBytes, target.sizeBytes);
    assert(task.path, "download task has no final path");

    const hostPath = join(hostDownloads, win32.basename(task.path));
    assertEquals((await stat(hostPath)).size, target.sizeBytes);
    await unlink(hostPath);

    const cancelled = await writeJson<ControlResult>("/downloads", {
      taskIds: [started.taskId],
      operation: "cancel",
    }, "PATCH");
    assertEquals(cancelled.success, true);
    assertEquals(cancelled.taskIds, [started.taskId]);
    assertEquals(cancelled.operation, "cancel");

    const after = await getJson<QueueResult>("/downloads");
    assertEquals(
      after.tasks.some((entry) => entry.taskId === started.taskId),
      false,
    );
  },
  120_000,
);
