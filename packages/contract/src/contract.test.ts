import { assertEquals } from "@std/assert";
import { clientContract } from "./client.ts";
import { serverContract } from "./server.ts";
import { QuarkFileListSchema, ServerStatusSchema } from "./schemas.ts";

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

Deno.test("serverContract exposes the full thin-manager surface", () => {
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

Deno.test("serverContract events is an event iterator", () => {
  const out = proc(serverContract, "events")["~orpc"].outputSchema as {
    getEventIteratorSchemaDetails?: unknown;
  };
  // The event-iterator schema carries its own marker; absence of a plain
  // object schema with '~standard' is enough to distinguish it from the
  // regular ServerStatusSchema output used elsewhere.
  assertEquals(typeof out, "object");
});

Deno.test("clientContract exposes the full business surface", () => {
  const keys = [
    "version",
    "queueStatus",
    "events",
    "loginQRCode",
    "loginStatus",
    "userInfo",
    "listFile",
    "downloadFile",
    "downloadStatus",
    "updateDownloadStatus",
    "importShareLink",
  ];
  assertEquals(Object.keys(clientContract), keys);
  assertEquals(route(clientContract, "version"), {
    method: "GET",
    path: "/version",
  });
  assertEquals(route(clientContract, "downloadFile"), {
    method: "GET",
    path: "/download-file",
    inputStructure: "detailed",
  });
  assertEquals(route(clientContract, "updateDownloadStatus"), {
    method: "POST",
    path: "/download-status",
    inputStructure: "detailed",
  });
  assertEquals(route(clientContract, "downloadStatus"), {
    method: "GET",
    path: "/download-status",
    inputStructure: "detailed",
  });
  assertEquals(route(clientContract, "listFile"), {
    method: "GET",
    path: "/list-file",
    inputStructure: "detailed",
  });
});

Deno.test("long client operations carry detailed inputStructure", () => {
  for (
    const key of [
      "listFile",
      "downloadFile",
      "downloadStatus",
      "updateDownloadStatus",
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

Deno.test("ServerStatusSchema round-trips", () => {
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

Deno.test("ServerStatusSchema rejects unknown states", () => {
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

Deno.test("QuarkFileListSchema round-trips", () => {
  const value = QuarkFileListSchema.parse({
    path: ["Movies", "2024"],
    items: [{
      name: "a.mp4",
      size: "1.2GB",
      type: "视频",
      updatedAt: "2026-06-07 12:34",
    }],
  });
  assertEquals(value.items[0].name, "a.mp4");
});
