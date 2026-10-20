import {
  deepStrictEqual as assertEquals,
  rejects as assertRejects,
} from "node:assert/strict";
import { test } from "bun:test";
import type { Page } from "playwright";
import {
  buildQuarkDownloadListUrl,
  buildQuarkFileDownloadUrl,
  buildQuarkTaskDetailUrl,
  fetchQuarkFileDownloadsInBrowser,
  requestQuarkFolderDownloadInBrowser,
  resolveFolderDownloadUrlsInBrowser,
} from "./download-api.ts";
import { QuarkApiError } from "./renderer-http.ts";

test("download URLs use the stable API contract", () => {
  const file = new URL(buildQuarkFileDownloadUrl());
  assertEquals(file.pathname, "/1/clouddrive/file/download");
  assertEquals(file.searchParams.get("pr"), "ucpro");
  assertEquals(file.searchParams.get("fr"), "pc");

  assertEquals(
    new URL(buildQuarkDownloadListUrl()).pathname,
    "/1/clouddrive/download/list",
  );

  // A folder scan is polled on the generic task endpoint, not on download/list.
  const detail = new URL(buildQuarkTaskDetailUrl("task-1"));
  assertEquals(detail.pathname, "/1/clouddrive/task");
  assertEquals(detail.searchParams.get("task_id"), "task-1");
  assertEquals(detail.searchParams.get("fetch_partial_download_file"), "y");
  assertEquals(
    new URL(buildQuarkTaskDetailUrl("task-1", { partialDownloadFile: false }))
      .searchParams.has("fetch_partial_download_file"),
    false,
  );
});

interface Response {
  status?: number;
  body?: unknown;
  text?: string;
}

function pageFor(responses: Response[]): Page {
  let index = 0;
  return {
    evaluate: (_callback: unknown, argument?: unknown): Promise<unknown> => {
      const target = (argument as { url?: string } | undefined)?.url ?? "";
      // Manifest URLs are absolute and fetched directly.
      if (target.startsWith("https://manifest.invalid/")) {
        const chunk = target.slice("https://manifest.invalid/".length);
        return Promise.resolve({
          status: 200,
          text: JSON.stringify([
            {
              fid: `${chunk}-a`,
              file_name: "a.mkv",
              file_type: 1,
              relative_path: "Season 1",
              size: 100,
              md5: "aaa",
            },
            {
              fid: `${chunk}-b`,
              file_name: "b.mkv",
              file_type: 1,
              relative_path: "Season 1",
              size: 200,
              md5: "bbb",
            },
            // Synthetic folder root marker, must be dropped.
            {
              fid: `${chunk}-root`,
              file_name: "/",
              file_type: 0,
              relative_path: "/",
            },
          ]),
        });
      }
      const response = responses[Math.min(index, responses.length - 1)];
      index++;
      return Promise.resolve({
        status: response.status ?? 200,
        text: response.text ?? JSON.stringify(response.body),
      });
    },
  } as unknown as Page;
}

test("fetchQuarkFileDownloadsInBrowser parses signed entries", async () => {
  const page = pageFor([{
    body: {
      code: 0,
      data: [
        {
          fid: "file-fid",
          file_name: "a.mp4",
          dir: false,
          size: 1024,
          md5: "abc",
          download_url: "https://example.invalid/a",
        },
      ],
    },
  }]);

  const entries = await fetchQuarkFileDownloadsInBrowser(page, ["file-fid"]);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].downloadUrl, "https://example.invalid/a");
  assertEquals(entries[0].sizeBytes, 1024);

  // An empty batch never hits the network.
  assertEquals(await fetchQuarkFileDownloadsInBrowser(page, []), []);
});

test("fetchQuarkFileDownloadsInBrowser rejects bad entries", async () => {
  await assertRejects(
    () =>
      fetchQuarkFileDownloadsInBrowser(
        pageFor([{ body: { code: 0, data: [{ fid: "x" }] } }]),
        ["x"],
      ),
    QuarkApiError,
  );
});

test("requestQuarkFolderDownloadInBrowser walks the manifest", async () => {
  const page = pageFor([
    {
      body: {
        code: 0,
        data: { task_id: "task-1" },
        metadata: { tq_gap: 200 },
      },
    },
    { body: { code: 0, data: { task_id: "task-1", status: 1 } } },
    {
      body: {
        code: 0,
        data: {
          task_id: "task-1",
          status: 2,
          download_url_list: ["https://manifest.invalid/0"],
        },
      },
    },
  ]);

  const scan = await requestQuarkFolderDownloadInBrowser(page, "dir-fid");
  assertEquals(scan.taskId, "task-1");
  assertEquals(scan.status, 2);
  assertEquals(scan.entries.map((entry) => entry.fid), ["0-a", "0-b"]);
  assertEquals(scan.entries[0].relativePath, "Season 1/a.mkv");
  assertEquals(scan.entries[0].dir, false);
});

test("requestQuarkFolderDownloadInBrowser surfaces failures", async () => {
  const page = pageFor([
    {
      body: {
        code: 0,
        data: { task_id: "task-1" },
        metadata: { tq_gap: 200 },
      },
    },
    { body: { code: 0, data: { task_id: "task-1", status: 3 } } },
  ]);
  await assertRejects(
    () => requestQuarkFolderDownloadInBrowser(page, "dir-fid"),
    QuarkApiError,
    "failed",
  );
});

test("resolveFolderDownloadUrlsInBrowser batches and honours the limit", async () => {
  const batches: number[] = [];
  const page = {
    evaluate: (_callback: unknown, argument?: unknown): Promise<unknown> => {
      const body = (argument as { body: { fids: string[] } }).body;
      batches.push(body.fids.length);
      return Promise.resolve({
        status: 200,
        text: JSON.stringify({
          code: 0,
          data: body.fids.map((fid) => ({
            fid,
            file_name: fid,
            dir: false,
            size: 1,
            md5: "m",
            download_url: `https://example.invalid/${fid}`,
          })),
        }),
      });
    },
  } as unknown as Page;

  const entryFor = (index: number) => ({
    fid: `fid-${index}`,
    name: `name-${index}`,
    relativePath: `name-${index}`,
    dir: false,
    sizeBytes: 10,
    md5: null,
    raw: {},
  });

  const many = Array.from({ length: 150 }, (_, i) => entryFor(i));
  const resolved = await resolveFolderDownloadUrlsInBrowser(page, many);
  assertEquals(batches, [100, 50]);
  assertEquals(resolved.size, 150);
  assertEquals(
    resolved.get("fid-149")?.downloadUrl,
    "https://example.invalid/fid-149",
  );

  batches.length = 0;
  const limited = await resolveFolderDownloadUrlsInBrowser(page, many, 2);
  assertEquals(batches, [2]);
  assertEquals(limited.size, 2);
});
