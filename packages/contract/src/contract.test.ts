import {
  deepStrictEqual as assertEquals,
  throws as assertThrows,
} from "node:assert/strict";
import { test } from "bun:test";
import { clientContract } from "./client.ts";
import {
  QuarkDownloadControlResultSchema,
  QuarkDownloadQueueSchema,
  QuarkDownloadStartResultSchema,
  QuarkFileInfoSchema,
  QuarkFileListSchema,
  QuarkLoginStatusSchema,
  QuarkShareUrlSchema,
  QuarkTaskListSchema,
  QuarkUpdateTaskResultSchema,
  QuarkUserInfoSchema,
  RawOptionSchema,
  ServerStatusSchema,
} from "./schemas.ts";

type AnyContractProc = {
  "~orpc": {
    route: { method?: string; path?: string; inputStructure?: string };
    inputSchema?: unknown;
    outputSchema?: unknown;
  };
};

function proc(contract: unknown, key: string): AnyContractProc {
  const p = (contract as Record<string, unknown>)[key];
  if (!p || typeof p !== "object") {
    throw new Error(`contract procedure ${key} not found`);
  }
  return p as AnyContractProc;
}

test("listFile is a plain JSON file API lookup", () => {
  const definition = proc(clientContract, "listFiles")["~orpc"];
  const output = definition.outputSchema as {
    getEventIteratorSchemaDetails?: unknown;
  };
  assertEquals(output.getEventIteratorSchemaDetails, undefined);

  const input = definition.inputSchema as {
    safeParse(value: unknown): { success: boolean };
  };
  assertEquals(input.safeParse({}).success, true);
  assertEquals(input.safeParse({ query: {} }).success, true);
  assertEquals(input.safeParse({ query: { fid: "0" } }).success, true);
  assertEquals(
    input.safeParse({ query: { fid: "folder-fid", raw: "true" } }).success,
    true,
  );
  // The old path-based input is gone; unknown query keys must be rejected.
  assertEquals(
    input.safeParse({ query: { path: "Movies" } }).success,
    false,
  );
});

test("fileInfo, taskList and updateTask schemas round-trip", () => {
  assertEquals(
    QuarkFileInfoSchema.parse({
      fid: "file-fid",
      name: "a.mp4",
      dir: false,
      dirFid: "folder-fid",
      sizeBytes: 1024,
      fileType: 1,
      formatType: "video/mp4",
      updatedAtSeconds: 1_780_000_000,
    }).dirFid,
    "folder-fid",
  );

  const tasks = QuarkTaskListSchema.parse({
    tasks: [{
      taskId: "task-1",
      taskType: 5,
      taskTypeName: "offline_download",
      status: "running",
      title: "a.mp4",
      sizeBytes: 1024,
      transferredBytes: 512,
      progressPercent: 50,
      fileNum: 1,
      completedNum: 1,
      dirFid: "folder-fid",
      downloadType: "MAGNET",
      createdAt: 1_780_000_000_000,
      updatedAt: 1_780_000_001_000,
    }],
    counts: {
      todo: 0,
      running: 1,
      finish: 2,
      fail: 0,
      pause: 0,
      total: 3,
    },
    cursor: null,
  });
  assertEquals(tasks.counts.total, 3);

  assertEquals(
    QuarkUpdateTaskResultSchema.parse({
      success: true,
      taskIds: ["task-1"],
      operation: "resume",
    }).operation,
    "resume",
  );
});

test("share save input accepts a share URL or bare id, rejects junk", () => {
  assertEquals(
    QuarkShareUrlSchema.parse("https://pan.quark.cn/s/abc"),
    "https://pan.quark.cn/s/abc",
  );
  assertEquals(QuarkShareUrlSchema.parse("abc123_-XYZ"), "abc123_-XYZ");
  for (const bad of ["", "  ", "not a url", "https://pan.quark.cn/s/", "https://example.org/s/abc", "!!!"]) {
    assertThrows(() => QuarkShareUrlSchema.parse(bad));
  }
});

test("local download schemas round-trip", () => {
  assertEquals(
    QuarkDownloadStartResultSchema.parse({
      fid: "file-fid",
      name: "a.mp4",
      dir: false,
      sizeBytes: 1024,
      directory: "C:\\users\\wume\\Downloads",
      taskId: "local-1",
    }).taskId,
    "local-1",
  );

  const queue = QuarkDownloadQueueSchema.parse({
    tasks: [{
      taskId: "local-1",
      name: "a.mp4",
      status: "running",
      statusCode: 3,
      progressPercent: 42.5,
      sizeBytes: 1024,
      transferredBytes: 435,
      speedBytesPerSec: 2048,
      path: "C:\\users\\wume\\Downloads\\a.mp4",
      error: null,
      createdAt: 1_780_000_000_000,
      updatedAt: 1_780_000_001_000,
      finishedAt: null,
    }],
    counts: { total: 1, running: 1, paused: 0, finished: 0, failed: 0 },
  });
  assertEquals(queue.tasks[0].status, "running");

  assertEquals(
    QuarkDownloadControlResultSchema.parse({
      success: true,
      taskIds: ["local-1"],
      operation: "cancel",
      removedPartials: [],
    }).operation,
    "cancel",
  );
});

test("ServerStatusSchema round-trips", () => {
  const value = ServerStatusSchema.parse({
    state: "running_visible",
    pid: 1234,
    alive: true,
    startedAt: 1700000000000,
    cdpActivityAt: 1700000001000,
    counts: { start: 1, stop: 0, minimize: 0 },
  });
  assertEquals(value.state, "running_visible");
  assertEquals(value.counts.start, 1);
});

test("ServerStatusSchema rejects unknown states", () => {
  let threw = false;
  try {
    ServerStatusSchema.parse({
      state: "hibernating",
      alive: false,
      counts: {},
    });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected parse to fail for unknown state");
});

test("QuarkFileListSchema round-trips", () => {
  const value = QuarkFileListSchema.parse({
    fid: "folder-fid",
    items: [{
      fid: "file-fid",
      name: "a.mp4",
      dir: false,
      sizeBytes: 1_288_490_188,
      size: "1.2GB",
      type: "视频",
      fileType: 1,
      formatType: "video/mp4",
      updatedAt: "2026-06-07 12:34",
      updatedAtSeconds: 1_780_000_000,
    }],
    total: 1,
    raw: { items: [{ file_name: "a.mp4" }] },
  });
  assertEquals(value.items[0].name, "a.mp4");
  assertEquals(value.items[0].sizeBytes, 1_288_490_188);
  assertEquals(value.raw?.items instanceof Array, true);

  assertEquals(
    QuarkFileListSchema.parse({
      fid: "folder-fid",
      items: [],
      total: 0,
    }).fid,
    "folder-fid",
  );
});

test("account schemas accept structured fields and raw data", () => {
  assertEquals(
    QuarkUserInfoSchema.parse({
      capacity: "4.3T/6T",
      useCapacity: 4741909538222,
      totalCapacity: 6597069766656,
      raw: { data: { use_capacity: 4741909538222 } },
    }).capacity,
    "4.3T/6T",
  );
  assertEquals(
    QuarkLoginStatusSchema.parse({
      loggedIn: false,
      raw: { code: 31001, status: 401 },
    }).loggedIn,
    false,
  );
});

test("raw option accepts boolean and query-string forms", () => {
  assertEquals(RawOptionSchema.parse(true), true);
  assertEquals(RawOptionSchema.parse(false), false);
  assertEquals(RawOptionSchema.parse("true"), true);
  assertEquals(RawOptionSchema.parse("false"), false);
  assertEquals(RawOptionSchema.parse("1"), true);
  assertEquals(RawOptionSchema.parse("0"), false);
  assertEquals(RawOptionSchema.parse(undefined), undefined);
});
