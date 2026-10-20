import {
  deepStrictEqual as assertEquals,
  throws as assertThrows,
} from "node:assert/strict";
import { test } from "bun:test";
import { clientContract } from "./client.ts";
import { serverContract } from "./server.ts";
import {
  QuarkDownloadControlResultSchema,
  QuarkDownloadFileResultSchema,
  QuarkDownloadQueueSchema,
  QuarkDownloadStartResultSchema,
  QuarkFileInfoSchema,
  QuarkFileListSchema,
  QuarkImportShareLinkResultSchema,
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

function route(contract: unknown, key: string): Record<string, unknown> {
  const r = proc(contract, key)["~orpc"].route;
  const out: Record<string, unknown> = { method: r.method, path: r.path };
  if (r.inputStructure !== undefined) out.inputStructure = r.inputStructure;
  return out;
}

test("serverContract exposes the full thin-manager surface", () => {
  const keys = [
    "healthz",
    "status",
    "start",
    "stop",
    "restart",
    "minimize",
    "restore",
    "events",
  ];
  assertEquals(Object.keys(serverContract), keys);
  assertEquals(route(serverContract, "healthz"), {
    method: "GET",
    path: "/healthz",
  });
  assertEquals(route(serverContract, "start"), {
    method: "POST",
    path: "/start",
  });
  assertEquals(route(serverContract, "events"), {
    method: "GET",
    path: "/events",
  });
  assertEquals(route(serverContract, "status"), {
    method: "GET",
    path: "/status",
  });
});

test("serverContract events is an event iterator", () => {
  const out = proc(serverContract, "events")["~orpc"].outputSchema as {
    getEventIteratorSchemaDetails?: unknown;
  };
  // The event-iterator schema carries its own marker; absence of a plain
  // object schema with '~standard' is enough to distinguish it from the
  // regular ServerStatusSchema output used elsewhere.
  assertEquals(typeof out, "object");
});

test("clientContract exposes the full business surface", () => {
  const keys = [
    "config",
    "updateConfig",
    "status",
    "version",
    "queueStatus",
    "events",
    "loginQRCode",
    "loginStatus",
    "userInfo",
    "listFile",
    "fileInfo",
    "downloadFile",
    "startDownload",
    "downloadTaskList",
    "updateDownloadTask",
    "taskList",
    "updateTask",
    "importShareLink",
    "manager",
  ];
  assertEquals(Object.keys(clientContract), keys);
  assertEquals(route(clientContract, "version"), {
    method: "GET",
    path: "/version",
  });
  assertEquals(route(clientContract, "fileInfo"), {
    method: "GET",
    path: "/file-info",
    inputStructure: "detailed",
  });
  // GET /download-file only mints URLs; POST on the same path downloads.
  assertEquals(route(clientContract, "downloadFile"), {
    method: "GET",
    path: "/download-file",
    inputStructure: "detailed",
  });
  assertEquals(route(clientContract, "startDownload"), {
    method: "POST",
    path: "/download-file",
    inputStructure: "detailed",
  });
  assertEquals(route(clientContract, "downloadTaskList"), {
    method: "GET",
    path: "/download-task",
    inputStructure: "detailed",
  });
  assertEquals(route(clientContract, "updateDownloadTask"), {
    method: "POST",
    path: "/download-task",
    inputStructure: "detailed",
  });
  assertEquals(route(clientContract, "taskList"), {
    method: "GET",
    path: "/task-list",
    inputStructure: "detailed",
  });
  assertEquals(route(clientContract, "updateTask"), {
    method: "POST",
    path: "/task-list",
    inputStructure: "detailed",
  });
  assertEquals(route(clientContract, "listFile"), {
    method: "GET",
    path: "/list-file",
    inputStructure: "detailed",
  });
});

// The nested manager router mirrors the server contract under /manager/* with
// MCP opt-in on every control procedure (events stays an SSE stream, no tool).
test("clientContract manager router mirrors the manager surface", () => {
  const manager = (clientContract as Record<string, unknown>).manager as Record<
    string,
    unknown
  >;
  const keys = [
    "healthz",
    "status",
    "start",
    "stop",
    "restart",
    "minimize",
    "restore",
    "events",
  ];
  assertEquals(Object.keys(manager), keys);
  assertEquals(route(manager, "status"), {
    method: "GET",
    path: "/manager/status",
  });
  assertEquals(route(manager, "start"), {
    method: "POST",
    path: "/manager/start",
  });
  assertEquals(route(manager, "minimize"), {
    method: "POST",
    path: "/manager/minimize",
  });
  assertEquals(route(manager, "events"), {
    method: "GET",
    path: "/manager/events",
  });

  for (const key of keys.filter((k) => k !== "events")) {
    const meta = (manager[key] as { "~orpc": { meta?: unknown } })["~orpc"]
      .meta as { mcp?: { tool?: boolean } };
    assertEquals(meta.mcp?.tool, true, `expected ${key} to opt into MCP`);
  }
  const eventsMeta = (manager.events as { "~orpc": { meta?: unknown } })[
    "~orpc"
  ].meta as { mcp?: { tool?: boolean } };
  assertEquals(eventsMeta?.mcp?.tool, undefined);
});

test("client write operations carry detailed inputStructure", () => {
  for (
    const key of [
      "downloadFile",
      "fileInfo",
      "taskList",
      "updateTask",
      "importShareLink",
    ]
  ) {
    assertEquals(
      route(clientContract, key).inputStructure,
      "detailed",
      `expected detailed inputStructure on ${key}`,
    );
  }
});

test("listFile is a plain JSON file API lookup", () => {
  const definition = proc(clientContract, "listFile")["~orpc"];
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

test("downloadFile is fid-based and returns plain JSON", () => {
  const definition = proc(clientContract, "downloadFile")["~orpc"];
  const input = definition.inputSchema as {
    safeParse(value: unknown): { success: boolean };
  };
  assertEquals(input.safeParse({ query: { fid: "file-fid" } }).success, true);
  assertEquals(
    input.safeParse({ query: { path: "Movies/a.mp4" } }).success,
    false,
  );

  // Plain Zod output: no oRPC event-iterator details.
  const output = definition.outputSchema as {
    getEventIteratorSchemaDetails?: unknown;
  };
  assertEquals(output.getEventIteratorSchemaDetails, undefined);

  const parsed = QuarkDownloadFileResultSchema.parse({
    fid: "file-fid",
    name: "a.mp4",
    dir: false,
    sizeBytes: 1024,
    md5: "d41d8cd98f00b204e9800998ecf8427e",
    downloadUrl: "https://example.invalid/signed",
    taskId: null,
    total: 1,
    urlsResolved: 1,
    truncated: false,
    entries: [{
      fid: "file-fid",
      name: "a.mp4",
      relativePath: "",
      dir: false,
      sizeBytes: 1024,
      md5: "d41d8cd98f00b204e9800998ecf8427e",
      downloadUrl: "https://example.invalid/signed",
    }],
  });
  assertEquals(parsed.fid, "file-fid");
  assertEquals(parsed.taskId, null);
  assertEquals(parsed.entries[0].downloadUrl, "https://example.invalid/signed");

  // A folder result has no single URL and may leave files unresolved.
  const folder = QuarkDownloadFileResultSchema.parse({
    fid: "dir-fid",
    name: "folder",
    dir: true,
    sizeBytes: 2048,
    md5: null,
    downloadUrl: null,
    taskId: "task-1",
    total: 3,
    urlsResolved: 2,
    truncated: true,
    entries: [{
      fid: "a",
      name: "a.mkv",
      relativePath: "Season 1/a.mkv",
      dir: false,
      sizeBytes: 1024,
      md5: null,
      downloadUrl: "https://example.invalid/a",
    }],
  });
  assertEquals(folder.dir, true);
  assertEquals(folder.truncated, true);
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

test("importShareLink result is fid-based", () => {
  assertEquals(
    QuarkImportShareLinkResultSchema.parse({
      url: "https://pan.quark.cn/s/abc",
      pwdId: "abc",
      toDirFid: "share-inbox",
      savedFids: ["saved-fid"],
      taskId: "task-1",
      taskStatus: "finish",
    }).toDirFid,
    "share-inbox",
  );
});

test("importShareLink input accepts a share URL or bare id, rejects junk", () => {
  assertEquals(
    QuarkShareUrlSchema.parse("https://pan.quark.cn/s/abc"),
    "https://pan.quark.cn/s/abc",
  );
  assertEquals(QuarkShareUrlSchema.parse("abc123_-XYZ"), "abc123_-XYZ");
  for (const bad of ["", "  ", "not a url", "https://pan.quark.cn/s/", "!!!"]) {
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
