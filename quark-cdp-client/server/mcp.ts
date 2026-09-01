// ──────────────────────────────────────────────────────────────────────────────
// MCP server. Keep API surface in sync with `server/router.ts`.
//
// The set of tools advertised via `tools/list` MUST match the keys of
// `MCP_TOOL_HANDLERS` below. The parity check at the bottom of this file runs
// at module load and throws if either side drifts, so adding a new quarkAction
// without dispatching it (or vice versa) is a build-breaking error, not a
// silent runtime 404.
// ──────────────────────────────────────────────────────────────────────────────

import type { Hono } from "hono";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { getBrowser, getBrowserQueueStatus } from "../client/browser.ts";
import {
  downloadFile,
  getDownloadStatus,
  getFileList,
  getLoginQRCode,
  getLoginStatus,
  getUserInfo,
  importShareLink,
  quarkActions,
  setDownloadStatus,
} from "../client/actions/index.ts";
import type {
  QuarkDownloadStatusMode,
  QuarkDownloadTaskOperation,
} from "../libs/schemas.ts";
import type { QuarkImportShareLinkResult } from "../client/actions/index.ts";
import { log } from "../libs/logger.ts";

// ── MCP protocol types ────────────────────────────────────────────────────────

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolContent = TextContent | ImageContent;

type ToolResult = { content: ToolContent[]; isError?: boolean };

type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id?: string | number | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
function unwrap<T>(result: any): T {
  // deno-lint-ignore no-explicit-any
  return (result as { match: (...args: any[]) => any }).match({
    ok: (v: T) => v,
    err: (e: Error): never => {
      throw e;
    },
  }) as T;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const zodToJsonSchemaConverter = new ZodToJsonSchemaConverter();

const TOOLS = [
  {
    name: "get_version",
    description: [
      "Return the Chromium build that Quark is running on (via CDP",
      "`Browser.getVersion`). Quick liveness check — if this returns a",
      "version string, the wake middleware and browser connection are both",
      "healthy.",
      "",
      "Throws if Playwright isn't attached yet (typical during the first",
      "few seconds after cold-start). No input.",
    ].join("\n"),
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_queue_status",
    description: [
      "Snapshot of the in-process browser-operation queue. All Quark-",
      "touching tools serialise behind this single slot (`concurrency: 1`)",
      "because they share one window.",
      "",
      "Returns `{running, current, queued, total}`. Useful for rate-limiting",
      "and for diagnosing why a request is slow (look for a long `current`",
      "label or growing `queued`).",
    ].join("\n"),
    inputSchema: { type: "object", properties: {} },
  },
  ...quarkActions.map((action) => ({
    name: action.metadata.mcp.name,
    description: action.metadata.description,
    inputSchema: zodToJsonSchemaConverter.convert(action.metadata.mcp.input, {
      strategy: "input",
    })[1],
  })),
];

// ── Tool dispatch ─────────────────────────────────────────────────────────────

// `MCP_TOOL_HANDLERS` is the single source of truth for which tools this
// server can actually invoke. The parity check at the bottom of this file
// verifies every entry in `TOOLS` has a matching key here, and vice versa.
//
// When you add a new quarkAction (or any other tool), add its handler here
// AND make sure it appears in `TOOLS` above — the module-load assertion will
// tell you immediately if you forget.
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const MCP_TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_version: async () => text({ version: getBrowser().version() }),

  get_queue_status: async () => text(getBrowserQueueStatus()),

  get_login_qrcode: async () => {
    const bytes = unwrap<Uint8Array>(await getLoginQRCode());
    return {
      content: [{
        type: "image",
        data: toBase64(bytes),
        mimeType: "image/png",
      }],
    };
  },

  get_login_status: async () =>
    text(unwrap<{ loggedIn: boolean }>(await getLoginStatus())),

  get_user_info: async () =>
    text(unwrap<{ capacity: string }>(await getUserInfo())),

  get_file_list: async (args) =>
    text(unwrap(await getFileList(args.path as string | undefined))),

  download_file: async (args) =>
    text(unwrap(await downloadFile(args.path as string))),

  get_download_status: async (args) =>
    text(
      unwrap(
        await getDownloadStatus(
          args.status as QuarkDownloadStatusMode | undefined,
        ),
      ),
    ),

  set_download_status: async (args) =>
    text(
      unwrap(
        await setDownloadStatus(
          args.taskName as string,
          args.operation as QuarkDownloadTaskOperation,
        ),
      ),
    ),

  import_share_link: async (args) =>
    text(
      unwrap<QuarkImportShareLinkResult>(
        await importShareLink(args.url as string),
      ),
    ),
};

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const handler = MCP_TOOL_HANDLERS[name];
  if (!handler) {
    return errResult(
      `Unknown tool: ${name}. ` +
        `If this tool is advertised via tools/list but not handled, the ` +
        `MCP_TOOL_HANDLERS map in server/mcp.ts is missing an entry.`,
    );
  }
  return await handler(args);
}

// ── Parity check ──────────────────────────────────────────────────────────────
// Runs at module load. Throws if `TOOLS` (advertised) and `MCP_TOOL_HANDLERS`
// (dispatched) drift apart. This is the guard that catches omissions like
// `import_share_link` being declared in quarkActions but not dispatched.
{
  const advertised = new Set(TOOLS.map((t) => t.name));
  const handled = new Set(Object.keys(MCP_TOOL_HANDLERS));
  const unhandled = [...advertised].filter((n) => !handled.has(n));
  const unadvertised = [...handled].filter((n) => !advertised.has(n));

  if (unhandled.length > 0 || unadvertised.length > 0) {
    throw new Error(
      `[mcp] API parity violation between TOOLS and MCP_TOOL_HANDLERS: ` +
        `advertised-but-unhandled=[${unhandled.join(", ")}], ` +
        `handled-but-unadvertised=[${unadvertised.join(", ")}]. ` +
        `If you added a quarkAction, also add a handler; if you added a ` +
        `handler, also expose it in TOOLS. See the header comment in ` +
        `server/mcp.ts.`,
    );
  }
}

// ── Route setup ───────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "quark-remote-client", version: "1.0.0" };

// `instructions` is returned in the MCP `initialize` response and shown to
// LLM clients as a system-prompt-level usage guide for THIS server. Keep it
// dense and practical: callers consume tool-level docs from `tools/list`, so
// this is the place for cross-cutting context (sync vs async, how to wait,
// when to call what, common pitfalls).
const SERVER_INSTRUCTIONS = [
  "# Quark Remote Client — MCP usage",
  "",
  "This server drives a headless Quark Cloud Drive Windows client running",
  "under Wine inside a sibling Docker container. All tools you see here are",
  "thin wrappers over Playwright actions against that one window — they",
  "share a single browser-operation slot (`concurrency: 1`).",
  "",
  "## Tool categories",
  "",
  "### Auth / account",
  "- `get_login_status` — cheap boolean check (5 s cache).",
  "- `get_login_qrcode` — PNG image; user scans with the Quark mobile app.",
  "  Returned as an MCP `image` content block.",
  "- `get_user_info` — storage capacity string. Requires login.",
  "",
  "### File browsing",
  "- `get_file_list {path?}` — list a directory. Path is forward-slash",
  "  separated; omit for root. Cached 30 s per path. Returns",
  "  `{path: string[], items: [{name, size, type, updatedAt}]}` with the",
  "  breadcrumb as `path` (root → []) and items in display order.",
  "",
  "### Downloads",
  "- `download_file {path}` — navigate to the parent folder, scroll the",
  "  target row into view, hover, and click the row's first hover-oper",
  "  item (the download button). Blocks until the click has been issued",
  "  (≤60 s). Returns `{name, alreadyQueued?}` — `alreadyQueued: true`",
  "  means the item was already in Quark's transport center and we",
  "  skipped the click. Accepts files OR folders; Quark packages folder",
  "  downloads into a single transport-center task on its end.",
  "",
  "### Download queue inspection",
  "- `get_download_status {status?}` — read Quark's transport center",
  "  (`running` / `complete` / `all`). Cached 5 s per mode. Returns",
  "  `{tasks: [...]}` with display-string fields. Use the row's `name`",
  "  as the `taskName` argument to `set_download_status`.",
  "- `set_download_status {taskName, operation}` — `resume` | `pause` |",
  "  `delete` a row. `delete` removes the entry from the UI but does NOT",
  "  delete the file from disk.",
  "",
  "### Sharing",
  "- `import_share_link {url}` — paste a `https://pan.quark.cn/s/...`",
  "  share URL; the client opens it, saves it to the user's drive, and",
  "  returns `{url, savedPath}`. Requires login.",
  "",
  "### Health / diagnostics",
  "- `get_version` — Chromium build string from CDP `Browser.getVersion`.",
  "  Quick liveness check.",
  "- `get_queue_status` — snapshot of the single-slot browser queue:",
  "  `{running, current, queued, total}`.",
  "",
  "## Common pitfalls",
  "",
  "- **First call after idle is slow.** The host container suspends Quark",
  "  after a few minutes of inactivity. The first business request after",
  "  that wakes it back up (a few seconds of cold-start). Subsequent",
  "  requests are instant.",
  "- **Concurrency is 1.** Every Quark-touching tool serialises behind",
  "  the same browser queue. Submitting 10 downloads in parallel doesn't",
  "  parallelise the clicks — just accept the serial behaviour.",
  "- **No login required for most reads from the home page**, but writes",
  "  (downloads, share imports, capacity reads) do require it. Guard with",
  "  `get_login_status` if you're unsure.",
].join("\n");

export function setupMcpRoute(app: Hono): void {
  app.post("/mcp", async (c) => {
    let body: JsonRpcRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
    }

    const { method, params, id } = body;
    const isNotification = id === undefined || id === null;

    const respond = (result: unknown) =>
      c.json({ jsonrpc: "2.0", result, id: id ?? null });

    const respondError = (code: number, message: string) =>
      c.json({ jsonrpc: "2.0", error: { code, message }, id: id ?? null });

    try {
      switch (method) {
        case "initialize": {
          const { protocolVersion } = (params ?? {}) as {
            protocolVersion?: string;
          };
          log.debug(
            `MCP initialize: client requested version ${protocolVersion}`,
          );
          return respond({
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: SERVER_INFO,
            // `instructions` is the place to put cross-cutting usage guidance
            // — see the top of this file for the body. Per-tool docs live in
            // each tool's `description` (surfaced via `tools/list`).
            instructions: SERVER_INSTRUCTIONS,
            capabilities: { tools: {} },
          });
        }

        case "notifications/initialized":
          // Client notification — no response
          return c.body(null, 204);

        case "ping":
          return isNotification ? c.body(null, 204) : respond({});

        case "tools/list":
          return respond({ tools: TOOLS });

        case "tools/call": {
          const { name, arguments: args = {} } = (params ?? {}) as {
            name: string;
            arguments?: Record<string, unknown>;
          };
          log.debug(`MCP tools/call: ${name}`);
          const result = await callTool(name, args as Record<string, unknown>);
          return respond(result);
        }

        default:
          return respondError(-32601, `Method not found: ${method}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`MCP error in "${method}": ${message}`);
      if (isNotification) return c.body(null, 204);
      return respondError(-32603, message);
    }
  });

  log.debug("MCP endpoint mounted at POST /mcp");
}
