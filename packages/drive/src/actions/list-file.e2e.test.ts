import assert, {
  deepStrictEqual as assertEquals,
} from "node:assert/strict";
import { test } from "bun:test";
import { chromium } from "playwright";

const enabled = process.env.QUARK_E2E === "1";
const apiUrl = process.env.QUARK_API_URL ?? process.env.CLIENT_URL ??
  "http://127.0.0.1:3000";
const cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9223";

interface FileListItem {
  fid: string;
  name: string;
  dir: boolean;
}

interface FileListResult {
  fid: string;
  items: FileListItem[];
  total: number;
  raw?: { fid: string; items: unknown[]; pages: unknown[] };
}

interface FileInfoResult {
  fid: string;
  name: string;
  dir: boolean;
  dirFid: string;
  raw?: Record<string, unknown>;
}

interface TaskListResult {
  tasks: unknown[];
  counts: { total: number };
  cursor: string | null;
  raw?: Record<string, unknown>;
}

function assertJsonContentType(contentType: string | null): void {
  assert(
    contentType?.startsWith("application/json"),
    `expected JSON, received ${contentType ?? "no content type"}`,
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { Accept: "application/json" },
  });
  assertEquals(response.status, 200);
  assertJsonContentType(response.headers.get("content-type"));
  return await response.json() as T;
}

test.skipIf(!enabled)(
  "business endpoints read Quark's API without touching the UI",
  async () => {
    const browser = await chromium.connectOverCDP(cdpUrl);
    try {
      const page = browser.contexts().flatMap((context) => context.pages())
        .find((candidate) => candidate.url().includes("renderer/index.html"));
      assert(page, "Quark main page was not found");

      const hashBefore = await page.evaluate(() => location.hash);

      const root = await getJson<FileListResult>("/list-file?raw=true");
      assert(Array.isArray(root.items));
      assertEquals(root.total, root.items.length);
      assertEquals(Object.hasOwn(root, "path"), false);
      assertEquals(Object.hasOwn(root, "source"), false);
      assert(root.raw && Array.isArray(root.raw.items));

      const direct = await getJson<FileListResult>(
        `/list-file?fid=${encodeURIComponent(root.fid)}&raw=true`,
      );
      assertEquals(direct.fid, root.fid);
      assertEquals(
        direct.items.map((item) => item.fid),
        root.items.map((item) => item.fid),
      );

      // file-info resolves a real fid to its parent.
      const first = root.items[0];
      if (first) {
        const info = await getJson<FileInfoResult>(
          `/file-info?fid=${encodeURIComponent(first.fid)}&raw=true`,
        );
        assertEquals(info.fid, first.fid);
        assertEquals(info.name, first.name);
        assert(typeof info.dirFid === "string");
        assert(info.raw !== undefined);
      }

      // Cloud tasks come from the task API, not the transport panel.
      const tasks = await getJson<TaskListResult>("/task-list?raw=true");
      assert(Array.isArray(tasks.tasks));
      assert(tasks.counts.total >= tasks.tasks.length);
      assert(tasks.raw !== undefined);

      // The old path-based input is gone and must not be silently ignored.
      const rejected = await fetch(
        `${apiUrl}/list-file?path=${encodeURIComponent("Movies")}`,
        { headers: { Accept: "application/json" } },
      );
      assertEquals(rejected.status, 400);

      const hashAfter = await page.evaluate(() => location.hash);
      assertEquals(hashAfter, hashBefore);
    } finally {
      // For a connectOverCDP browser Playwright's close() disconnects the
      // client connection; it does not terminate the externally owned Quark
      // process.
      await browser.close();
    }
  },
);
