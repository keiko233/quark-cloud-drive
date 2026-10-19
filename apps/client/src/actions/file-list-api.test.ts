import { assertEquals, assertRejects } from "@std/assert";
import type { Page } from "playwright";
import {
  buildQuarkFileListUrl,
  collectQuarkFileList,
  FILE_LIST_API_PAGE_SIZE,
  formatQuarkFileSize,
  formatQuarkUpdatedAt,
  listQuarkFolderInBrowser,
  mapQuarkFileListItem,
  type QuarkFileListApiItem,
  type QuarkFileListApiPage,
} from "./file-list-api.ts";
import { QuarkApiError } from "./renderer-http.ts";

const updatedAt = Date.UTC(2026, 4, 26, 13, 2) / 1000;

function apiItem(
  overrides: Partial<QuarkFileListApiItem> = {},
): QuarkFileListApiItem {
  return {
    fid: "fid",
    file_name: "alpha",
    dir: false,
    size: 1024,
    file_type: 1,
    format_type: "application/octet-stream",
    updated_at: updatedAt,
    ...overrides,
    raw: overrides.raw ??
      {
        fid: overrides.fid ?? "fid",
        file_name: overrides.file_name ?? "alpha",
      },
  };
}

function apiPage(
  page: number,
  items: QuarkFileListApiItem[],
  total: number,
  size = FILE_LIST_API_PAGE_SIZE,
): QuarkFileListApiPage {
  return {
    page,
    items,
    total,
    size,
    count: items.length,
    rawMetadata: { _page: page, _size: size, _total: total },
  };
}

function apiPayload(items: unknown[]): Record<string, unknown> {
  return {
    code: 0,
    data: { list: items },
    metadata: {
      _page: 1,
      _size: FILE_LIST_API_PAGE_SIZE,
      _total: items.length,
    },
  };
}

function fakePage(payloads: Record<string, Record<string, unknown>>): Page {
  return {
    evaluate: (
      _callback: unknown,
      argument?: unknown,
    ): Promise<unknown> => {
      if (
        argument && typeof argument === "object" && "url" in argument
      ) {
        const url = new URL(String((argument as { url: string }).url));
        const fid = url.searchParams.get("pdir_fid") ?? "0";
        const payload = payloads[fid];
        if (!payload) throw new Error(`unexpected fid ${fid}`);
        return Promise.resolve({
          status: 200,
          text: JSON.stringify(payload),
        });
      }
      return Promise.resolve("Asia/Shanghai");
    },
  } as unknown as Page;
}

Deno.test("buildQuarkFileListUrl uses the stable API contract", () => {
  const url = new URL(buildQuarkFileListUrl("folder-fid", 2, 25));
  assertEquals(url.pathname, "/1/clouddrive/file/sort");
  assertEquals(url.searchParams.get("pr"), "ucpro");
  assertEquals(url.searchParams.get("fr"), "pc");
  assertEquals(url.searchParams.get("pdir_fid"), "folder-fid");
  assertEquals(url.searchParams.get("_page"), "2");
  assertEquals(url.searchParams.get("_size"), "25");
  assertEquals(url.searchParams.get("_fetch_total"), "1");
  assertEquals(url.searchParams.get("_fetch_sub_dirs"), "0");
  assertEquals(url.searchParams.has("ut"), false);
  assertEquals(url.searchParams.has("guid"), false);
});

Deno.test("collectQuarkFileList follows metadata total across pages", async () => {
  const calls: number[] = [];
  const metadata: Record<string, unknown>[] = [];
  const pages: Record<number, QuarkFileListApiPage> = {
    1: apiPage(
      1,
      [
        apiItem({ fid: "a", file_name: "a" }),
        apiItem({ fid: "b", file_name: "b" }),
      ],
      3,
      2,
    ),
    2: apiPage(2, [apiItem({ fid: "c", file_name: "c" })], 3, 2),
  };

  const items = await collectQuarkFileList((page) => {
    calls.push(page);
    return Promise.resolve(pages[page]);
  }, {
    onPage: (page) => metadata.push(page.rawMetadata),
  });

  assertEquals(calls, [1, 2]);
  assertEquals(items.map((item) => item.fid), ["a", "b", "c"]);
  assertEquals(items[0].raw.file_name, "a");
  assertEquals(metadata.map((page) => page._page), [1, 2]);
});

Deno.test("collectQuarkFileList rejects incomplete responses", async () => {
  await assertRejects(
    () =>
      collectQuarkFileList(() =>
        Promise.resolve(apiPage(1, [apiItem({ fid: "a" })], 3, 2))
      ),
    QuarkApiError,
    "incomplete",
  );
});

Deno.test("listQuarkFolderInBrowser lists by fid", async () => {
  const page = fakePage({
    "0": apiPayload([
      {
        fid: "folder-fid",
        file_name: "Movies",
        dir: true,
        size: 0,
      },
      { fid: "root-file", file_name: "root.mp4", dir: false, size: 10 },
    ]),
    "folder-fid": apiPayload([
      { fid: "movie-fid", file_name: "movie.mp4", dir: false, size: 20 },
    ]),
  });

  const direct = await listQuarkFolderInBrowser(page, "folder-fid", {
    raw: true,
  });
  assertEquals(direct.fid, "folder-fid");
  assertEquals(direct.items.map((item) => item.fid), ["movie-fid"]);
  assertEquals(direct.raw?.fid, "folder-fid");
  assertEquals((direct.raw?.items as unknown[]).length, 1);

  const root = await listQuarkFolderInBrowser(page, undefined, { raw: true });
  assertEquals(root.fid, "0");
  assertEquals(root.items.map((item) => item.fid), [
    "folder-fid",
    "root-file",
  ]);
  assertEquals((root.raw?.pages as unknown[]).length, 1);
});

Deno.test("formatQuarkFileSize matches Quark display rules", () => {
  assertEquals(formatQuarkFileSize(undefined, true), "-");
  assertEquals(formatQuarkFileSize(0, false), "0B");
  assertEquals(formatQuarkFileSize(647, false), "647B");
  assertEquals(formatQuarkFileSize(1024, false), "1KB");
  assertEquals(formatQuarkFileSize(10_956, false), "10.7KB");
  assertEquals(formatQuarkFileSize(32.7 * 1024 ** 2, false), "32.7MB");
  assertEquals(formatQuarkFileSize(2.6 * 1024 ** 3, false), "2.6GB");
});

Deno.test("formatQuarkUpdatedAt uses renderer timezone and seconds", () => {
  assertEquals(
    formatQuarkUpdatedAt(updatedAt, "Asia/Shanghai"),
    "2026/05/26 21:02",
  );
  assertEquals(
    formatQuarkUpdatedAt(updatedAt * 1000, "Asia/Shanghai"),
    "2026/05/26 21:02",
  );
});

Deno.test("mapQuarkFileListItem maps folders and files", () => {
  assertEquals(
    mapQuarkFileListItem(apiItem({ dir: true, size: 0 }), "Asia/Shanghai"),
    {
      fid: "fid",
      name: "alpha",
      dir: true,
      sizeBytes: 0,
      size: "-",
      type: "文件夹",
      fileType: 1,
      formatType: "application/octet-stream",
      updatedAt: "2026/05/26 21:02",
      updatedAtSeconds: updatedAt,
    },
  );

  assertEquals(
    mapQuarkFileListItem(
      apiItem({ file_name: "archive.zip", format_type: "application/zip" }),
      "Asia/Shanghai",
    ).type,
    "压缩文件",
  );
  assertEquals(
    mapQuarkFileListItem(
      apiItem({
        file_name: "installer.apk",
        format_type: "application/vnd.android.package-archive",
      }),
      "Asia/Shanghai",
    ).type,
    "安装包",
  );
  assertEquals(
    mapQuarkFileListItem(
      apiItem({ file_name: "movie.mp4", format_type: "video/mp4" }),
      "Asia/Shanghai",
    ).type,
    "视频",
  );
  assertEquals(
    mapQuarkFileListItem(
      apiItem({
        file_name: "unknown.bin",
        format_type: "application/octet-stream",
      }),
      "Asia/Shanghai",
    ).type,
    "文件",
  );
});
