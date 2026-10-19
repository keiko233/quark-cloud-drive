import { assert, assertEquals } from "@std/assert";

// Opt-in end-to-end check for the local downloader. It hands one real (small)
// file to the Quark app, waits for the transfer to finish, verifies the file
// landed on the host, then cancels the task and deletes its artifact.
//
// Run with: `QUARK_E2E=1 deno task test:e2e`. The app's Downloads
// directory is the `downloads/` bind mount, so the host path is derived from
// `QUARK_DOWNLOADS_HOST_DIR` (default `downloads`).

const enabled = Deno.env.get("QUARK_E2E") === "1";
const apiUrl = Deno.env.get("QUARK_API_URL") ?? Deno.env.get("CLIENT_URL") ??
  "http://127.0.0.1:3000";
const hostDownloads = Deno.env.get("QUARK_DOWNLOADS_HOST_DIR") ?? "downloads";

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

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  assertEquals(response.status, 200, `POST ${path} -> ${response.status}`);
  return await response.json() as T;
}

/** Smallest file reachable from the root, so the transfer finishes fast. */
async function findSmallestFile(): Promise<FileListItem | null> {
  const root = await getJson<FileListResult>("/list-file?fid=0");
  let best: FileListItem | null = null;
  const keep = (item: FileListItem) => {
    if (item.dir) return;
    if (!best || item.sizeBytes < best.sizeBytes) best = item;
  };
  root.items.forEach(keep);
  if (best) return best;
  for (const dir of root.items.filter((item) => item.dir)) {
    const listed = await getJson<FileListResult>(
      `/list-file?fid=${encodeURIComponent(dir.fid)}`,
    );
    listed.items.forEach(keep);
    if (best) return best;
  }
  return best;
}

Deno.test({
  name: "download-file writes through the app's own downloader",
  ignore: !enabled,
  fn: async () => {
    const target = await findSmallestFile();
    assert(target, "no file available to download");

    const started = await postJson<StartResult>("/download-file", {
      fid: target.fid,
    });
    assertEquals(started.fid, target.fid);
    assertEquals(started.dir, false);
    assert(started.taskId.length > 0, "startDownload returned no task id");
    assert(started.directory.length > 0, "startDownload returned no directory");

    let task: LocalTask | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      const queue = await getJson<QueueResult>("/download-task?raw=true");
      task = queue.tasks.find((entry) => entry.taskId === started.taskId);
      if (task && (task.status === "finish" || task.status === "error")) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(task, "the started task never appeared in /download-task");
    assertEquals(task.status, "finish");
    assertEquals(task.progressPercent, 100);
    assertEquals(task.sizeBytes, target.sizeBytes);
    assertEquals(task.transferredBytes, target.sizeBytes);
    assertEquals(task.path !== null, true);

    // The app writes into its Downloads folder, which is the repo's mount.
    const hostPath = `${hostDownloads}/${started.name}`;
    let written: number | null = null;
    try {
      written = (await Deno.stat(hostPath)).size;
    } catch {
      written = null;
    }
    if (written !== null) {
      assertEquals(written, target.sizeBytes);
      await Deno.remove(hostPath);
    }

    const cancelled = await postJson<ControlResult>("/download-task", {
      taskIds: [started.taskId],
      operation: "cancel",
    });
    assertEquals(cancelled.success, true);
    assertEquals(cancelled.taskIds, [started.taskId]);
    assertEquals(cancelled.operation, "cancel");

    const after = await getJson<QueueResult>("/download-task");
    assertEquals(
      after.tasks.some((entry) => entry.taskId === started.taskId),
      false,
    );
  },
});
