import { assertEquals, assertRejects } from "@jsr/std__assert";
import { test } from "bun:test";
import type { Page } from "playwright";
import {
  buildQuarkFileInfoUrl,
  fetchQuarkFileInfoInBrowser,
  mapQuarkFileInfo,
  parseQuarkFileInfoData,
  ROOT_FID,
} from "./file-info-api.ts";
import { QuarkApiError } from "./renderer-http.ts";

type JsonObject = Record<string, unknown>;

function infoPayload(
  fid: string,
  name: string,
  parentFid: string,
  dir: boolean,
): JsonObject {
  return {
    code: 0,
    status: 200,
    data: {
      fid,
      file_name: name,
      pdir_fid: parentFid,
      dir,
      size: dir ? 0 : 1024,
      file_type: dir ? 0 : 1,
      format_type: dir ? "" : "video/mp4",
      updated_at: 1_780_000_000,
    },
  };
}

function fakePage(payloads: Record<string, JsonObject>): Page {
  return {
    evaluate: (
      _callback: unknown,
      argument?: unknown,
    ): Promise<unknown> => {
      if (argument && typeof argument === "object" && "url" in argument) {
        const url = new URL(String((argument as { url: string }).url));
        const fid = url.searchParams.get("fid") ?? "";
        const payload = payloads[fid];
        if (!payload) throw new Error(`unexpected fid ${fid}`);
        return Promise.resolve({
          status: 200,
          text: JSON.stringify(payload),
        });
      }
      return Promise.resolve(undefined);
    },
  } as unknown as Page;
}

test("buildQuarkFileInfoUrl uses the stable API contract", () => {
  const url = new URL(buildQuarkFileInfoUrl("folder-fid"));
  assertEquals(url.pathname, "/1/clouddrive/file/info");
  assertEquals(url.searchParams.get("pr"), "ucpro");
  assertEquals(url.searchParams.get("fr"), "pc");
  assertEquals(url.searchParams.get("fid"), "folder-fid");
  assertEquals(url.searchParams.get("need_profile_tags"), "1");
});

test("ROOT_FID is the drive root", () => {
  assertEquals(ROOT_FID, "0");
});

test("parseQuarkFileInfoData normalizes the raw entry", () => {
  const entry = parseQuarkFileInfoData(
    infoPayload("movie-fid", "movie.mp4", "folder-fid", false).data,
  );
  assertEquals(entry.fid, "movie-fid");
  assertEquals(entry.name, "movie.mp4");
  assertEquals(entry.dir, false);
  assertEquals(entry.parentFid, "folder-fid");
  assertEquals(entry.size, 1024);
  assertEquals(entry.raw.file_name, "movie.mp4");
});

test("parseQuarkFileInfoData rejects incomplete entries", () => {
  try {
    parseQuarkFileInfoData({ fid: "x" });
    throw new Error("expected parse to fail");
  } catch (error) {
    assertEquals(error instanceof QuarkApiError, true);
  }
});

test("fetchQuarkFileInfoInBrowser reads one fid", async () => {
  const page = fakePage({
    "movie-fid": infoPayload("movie-fid", "movie.mp4", "folder-fid", false),
  });
  const entry = await fetchQuarkFileInfoInBrowser(page, "movie-fid");
  assertEquals(entry.parentFid, "folder-fid");
  await assertRejects(
    () => fetchQuarkFileInfoInBrowser(page, "missing-fid"),
    Error,
  );
});

test("mapQuarkFileInfo projects the contract shape", () => {
  const entry = parseQuarkFileInfoData(
    infoPayload("movie-fid", "movie.mp4", "folder-fid", false).data,
  );

  assertEquals(mapQuarkFileInfo(entry, false), {
    fid: "movie-fid",
    name: "movie.mp4",
    dir: false,
    dirFid: "folder-fid",
    sizeBytes: 1024,
    fileType: 1,
    formatType: "video/mp4",
    updatedAtSeconds: 1_780_000_000,
  });

  const withRaw = mapQuarkFileInfo(entry, true);
  assertEquals(withRaw.raw?.fid, "movie-fid");
});
