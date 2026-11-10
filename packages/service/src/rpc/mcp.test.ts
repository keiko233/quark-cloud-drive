import assert, { deepStrictEqual as assertEquals } from "node:assert/strict";
import { test } from "bun:test";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { Browser } from "playwright";
import { kvStore, QUARK_HOME_PAGE_URL, setBrowser } from "@quark/drive";
import { handleMcpRequest } from "./mcp.ts";
import { clientRouter } from "./router.ts";

const rest = new OpenAPIHandler(clientRouter);

async function mcp(method: string, params?: object) {
  const response = await handleMcpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("mcp-session-id"), null);
  const reply = await response.json();
  assert(!reply.error, JSON.stringify(reply.error));
  return reply.result;
}

function tool(name: string, args: object) {
  return mcp("tools/call", { name, arguments: args });
}

async function http(path: string, body?: object) {
  const result = await rest.handle(new Request(`http://localhost${path}`, body ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  } : undefined), { context: {} });
  assert(result.matched, `no REST route for ${path}`);
  assertEquals(result.response.status, 200);
  return result.response.json();
}

test("MCP exposes only drive tools with flat arguments; the URL-only REST route is gone", async () => {
  const init = await mcp("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert(init.capabilities.tools);
  const { tools } = await mcp("tools/list");
  const names = tools.map((item: { name: string }) => item.name).sort();
  assertEquals(names, [
    "control_cloud_tasks", "control_downloads", "get_account", "get_file",
    "get_share_import", "list_cloud_tasks", "list_downloads", "list_files",
    "login_qr_code", "login_status", "save_share", "start_download",
  ]);
  const download = tools.find((item: { name: string }) => item.name === "start_download");
  assertEquals(Object.keys(download.inputSchema.properties), ["fid"]);
  assertEquals(download.inputSchema.required, ["fid"]);
  const old = await rest.handle(new Request("http://localhost/download-file?fid=1"), { context: {} });
  assertEquals(old.matched, false);
  const invalid = await tool("start_download", { query: { fid: "wrong-shape" } });
  assertEquals(invalid.isError, true);
});

test("MCP and REST share native downloads and verify the same share task", async () => {
  await kvStore.open();
  const downloads: Array<Record<string, unknown>> = [];
  let saveCount = 0;
  let returnTaskId = true;
  const nativeWindow = {
    require: (module: string) => {
      if (module === "os") return { homedir: () => "C:/users/wineuser" };
      if (module === "path") return { join: (...parts: string[]) => parts.join("/") };
      throw new Error(`unexpected native module ${module}`);
    },
    store: {
      dispatch: { downloadTask: {
        create: async (input: { infos: [{ fid: string }] }) => {
          downloads.push({ id: 901, fid: input.infos[0].fid, name: "example.txt", status: 3 });
        },
      } },
      getState: () => ({ downloadTask: { transportTasks: downloads, completeTasks: [] } }),
    },
  };
  const page = {
    url: () => QUARK_HOME_PAGE_URL,
    waitForLoadState: async () => {},
    evaluate: async (fn: Function, argument?: { url?: string; body?: Record<string, unknown> }) => {
      if (!argument?.url) {
        const original = Object.getOwnPropertyDescriptor(globalThis, "window");
        Object.defineProperty(globalThis, "window", { configurable: true, value: nativeWindow });
        try {
          return await fn(argument);
        } finally {
          if (original) Object.defineProperty(globalThis, "window", original);
          else Reflect.deleteProperty(globalThis, "window");
        }
      }
      const url = new URL(argument.url);
      let data: object;
      switch (url.pathname) {
        case "/1/clouddrive/file/info":
          data = { fid: "file-1", file_name: "example.txt", size: 64, pdir_fid: "0", file_type: 1, dir: false };
          break;
        case "/1/clouddrive/share/sharepage/token":
          assertEquals(argument.body?.passcode, "1234");
          data = { stoken: "private-stoken" };
          break;
        case "/1/clouddrive/share/sharepage/detail":
          data = { list: [{ fid: "source", file_name: "example.txt", share_fid_token: "source-token" }] };
          break;
        case "/1/clouddrive/share/sharepage/save":
          saveCount++;
          assertEquals(argument.body?.pdir_fid, "0");
          assertEquals(argument.body?.to_pdir_fid, "target");
          data = returnTaskId ? { task_id: "share-1" } : {};
          break;
        case "/1/clouddrive/task":
          assertEquals(url.searchParams.get("task_id"), "share-1");
          data = url.searchParams.get("retry_index") === "0"
            ? { status: 1 }
            : { status: 2, save_as: { save_as_top_fids: ["saved"] } };
          break;
        default:
          throw new Error(`unexpected Quark API request: ${url.pathname}`);
      }
      return { status: 200, text: JSON.stringify({ code: 0, data }) };
    },
  };
  setBrowser({
    isConnected: () => true,
    contexts: () => [{ pages: () => [page] }],
  } as unknown as Browser);

  try {
    const download = await tool("start_download", { fid: "file-1" });
    assert(!download.isError, JSON.stringify(download.content));
    assertEquals(download.structuredContent.taskId, "901");
    assertEquals(downloads.length, 1);
    const queue = await http("/downloads?taskId=901");
    assertEquals(queue.tasks.map((item: { taskId: string }) => item.taskId), ["901"]);
    assertEquals(queue.tasks[0].status, "running");

    const save = await tool("save_share", {
      url: "https://pan.quark.cn/s/example?pwd=1234",
      toFid: "target",
    });
    assert(!save.isError, JSON.stringify(save.content));
    assertEquals(save.structuredContent, {
      taskId: "share-1", toDirFid: "target", status: "submitted",
    });
    const pending = await http("/share-imports?taskId=share-1");
    assertEquals(pending.status, "pending");
    const done = await tool("get_share_import", {
      taskId: "share-1", retryIndex: pending.nextRetryIndex,
    });
    assertEquals(done.structuredContent.status, "completed");
    assertEquals(done.structuredContent.savedFids, ["saved"]);
    assertEquals(saveCount, 1);

    returnTaskId = false;
    const rejected = await tool("save_share", {
      url: "https://pan.quark.cn/s/example", passcode: "1234", toFid: "target",
    });
    assertEquals(rejected.isError, true);
    assertEquals(rejected.structuredContent.code, "BAD_GATEWAY");
    assert.match(rejected.structuredContent.message, /submission could not be confirmed/);
  } finally {
    setBrowser(null);
  }
});
