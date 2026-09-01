// MCP exposure for the client router.
//
// The shared clientContract (packages/contract) is the single source of truth:
// each procedure declares `meta.mcp.tool: true` to opt in. This module walks
// the IMPLEMENTED router and registers every opted-in procedure as an MCP tool
// on the official @modelcontextprotocol/sdk (WebStandard Streamable HTTP),
// calling back into the procedure via oRPC's `call`.
//
// Note: the community `orpc-mcp` package requires oRPC v2 (beta); we're on
// v1.14, so we use this small SDK bridge instead (keeps one source of truth —
// the contract — rather than a duplicate TOOLS/MCP_TOOL_HANDLERS mapping).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { call, isProcedure } from "@orpc/server";
import type { AnyRouter } from "@orpc/server";
import { clientRouter } from "./router.ts";
import { log } from "../logger.ts";

const SERVER_NAME = "quark-remote-client";
const SERVER_VERSION = "1.0.0";
const SERVER_INSTRUCTIONS = [
  "# Quark Remote Client — MCP usage",
  "",
  "Drives a headless Quark Cloud Drive client over CDP. All tools serialise",
  "behind a single browser-operation slot (concurrency 1) because they share",
  "one window.",
  "",
  "## Common pitfalls",
  "",
  "- **First call after idle is slow**: the host may have minimized/stopped",
  "  Quark; the first request wakes it (a few seconds of cold-start).",
  "- **Concurrency is 1**: tools are served serially, not in parallel.",
  "- **Writes require login**: downloads, share imports, and capacity reads",
  "  need an authenticated session. Guard with `login_status`.",
].join("\n");

interface McpToolMeta {
  mcp?: { tool?: boolean; name?: string };
}

/** Whether a procedure opts in to MCP exposure. */
function isMcpTool(meta: unknown): meta is McpToolMeta {
  return typeof meta === "object" && meta !== null &&
    (meta as McpToolMeta).mcp?.tool === true;
}

/**
 * Derive the flat MCP tool args schema + an args→procedure-input wrapper from
 * the contract's detailed input structure. MCP tools take flat args; the
 * contract uses `{query}`/`{body}`/`{params}` envelopes.
 */
function mcpArgsFor(
  inputSchema: unknown,
  method: string | undefined,
): {
  inputSchema: unknown;
  toInput: (args: Record<string, unknown>) => unknown;
} {
  // The contract input is a ZodObject with detail keys.
  const obj = inputSchema as
    | { shape?: Record<string, unknown> }
    | undefined;
  const shape = obj?.shape ?? {};
  const keys = Object.keys(shape);

  // GET → query, POST → body (our procedures only use one envelope).
  const key = method === "POST" || method === "PUT" || method === "PATCH"
    ? "body"
    : "query";
  const flat = shape[key] ?? shape[keys[0]];

  return {
    inputSchema: flat,
    toInput: (args) => ({ [key]: args }),
  };
}

/**
 * Walk the implemented router and register every MCP-opted-in procedure as a
 * tool on the given McpServer.
 */
function registerRouterTools(mcp: McpServer, router: AnyRouter): number {
  let count = 0;

  function walk(node: AnyRouter, path: string[]): void {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== "object") continue;
      if (isProcedure(value)) {
        const proc = value as {
          "~orpc"?: {
            route?: { description?: string; method?: string };
            meta?: unknown;
            inputSchema?: unknown;
          };
        };
        const def = proc["~orpc"];
        const meta = def?.meta;
        if (!isMcpTool(meta)) continue;
        // Tool name: snake_case join of the router path + key.
        const name = [...path, key].map(snake).join("_");
        const description = def?.route?.description;
        const { inputSchema, toInput } = mcpArgsFor(
          def?.inputSchema,
          def?.route?.method,
        );

        mcp.registerTool(
          name,
          {
            title: name,
            description,
            inputSchema,
          },
          // deno-lint-ignore no-explicit-any
          async (args: any, extra: any) => {
            try {
              const result = await call(
                value as never,
                toInput((args ?? {}) as Record<string, unknown>) as never,
                { context: {}, signal: extra?.signal },
              );
              // Handle the File output of login_qrcode specially.
              if (result instanceof File) {
                const buf = new Uint8Array(await result.arrayBuffer());
                return {
                  content: [{
                    type: "image",
                    data: toBase64(buf),
                    mimeType: result.type || "image/png",
                  }],
                };
              }
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
              };
            } catch (error) {
              return {
                isError: true,
                content: [{
                  type: "text",
                  text: error instanceof Error ? error.message : String(error),
                }],
              };
            }
          },
        );
        count++;
      } else {
        walk(value as AnyRouter, [...path, key]);
      }
    }
  }

  walk(router, []);
  return count;
}

export function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── Session management ───────────────────────────────────────────────────────
// The Streamable HTTP protocol (SDK v1.30) is session-based: the client opens
// with `initialize`, receives an `mcp-session-id`, and sends it on every
// subsequent request. We keep one McpServer + transport per session.

const sessions = new Map<
  string,
  { transport: WebStandardStreamableHTTPServerTransport; server: McpServer }
>();

/** Build a fresh McpServer with every MCP-opted-in procedure registered. */
function createMcpServer(): McpServer {
  const mcp = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    instructions: SERVER_INSTRUCTIONS,
  });
  const count = registerRouterTools(mcp, clientRouter);
  log.info(`MCP: registered ${count} tools`);
  return mcp;
}

async function createSession(): Promise<
  { transport: WebStandardStreamableHTTPServerTransport; server: McpServer }
> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      sessions.set(sessionId, { transport, server });
    },
    onsessionclosed: (sessionId: string) => {
      sessions.delete(sessionId);
    },
  });
  const server = createMcpServer();
  await server.connect(transport);
  return { transport, server };
}

/**
 * Handle an MCP request over Streamable HTTP (WebStandard transport).
 * Session-aware: reuses the transport/server established by `initialize`.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  let entry: {
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
  };
  if (existing) {
    entry = existing;
  } else {
    entry = await createSession();
  }

  try {
    return await entry.transport.handleRequest(request);
  } catch (error) {
    // On a non-initialize request without a session this throws; fall back to
    // a fresh stateless attempt so simple probing still works.
    log.debug(
      `MCP request failed: ${error instanceof Error ? error.message : error}`,
    );
    throw error;
  }
}
