import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { call, isProcedure, ORPCError } from "@orpc/server";
import { z } from "zod";
import { clientRouter } from "./router.ts";

const instructions = [
  "Use list_files to find a Quark fid (root: 0). Use login_qr_code if sign-in is required.",
  "For local downloads, call start_download once, then list_downloads with the returned taskId. " +
    "Only finish means the file is available in the server's Downloads directory.",
  "For saving shares to the cloud drive, call save_share once, then get_share_import with the returned taskId. " +
    "If pending, wait briefly and pass nextRetryIndex as retryIndex. Only completed means the save finished.",
].join("\n");

function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

/** MCP flattens a procedure's one input envelope and omits REST's raw option. */
function toolInput(schema: unknown) {
  if (schema === undefined) {
    return { schema: z.strictObject({}), wrap: () => undefined };
  }
  if (!(schema instanceof z.ZodObject)) throw new Error("Expected a tool input object");
  const keys = Object.keys(schema.shape);
  const key = keys[0];
  if (keys.length !== 1 || (key !== "query" && key !== "body")) {
    throw new Error("Expected a single query or body for a tool");
  }
  const nested = schema.shape[key];
  const object = nested instanceof z.ZodOptional ? nested.unwrap() : nested;
  if (!(object instanceof z.ZodObject)) throw new Error("Expected a tool arguments object");
  const { raw: _raw, ...shape } = object.shape;
  return {
    schema: z.strictObject(shape),
    wrap: (args: Record<string, unknown>) => ({ [key]: args }),
  };
}

function createMcpServer(): McpServer {
  const mcp = new McpServer({ name: "quark-cloud-drive", version: "2.0.0" }, { instructions });

  for (const [key, procedure] of Object.entries(clientRouter)) {
    if (!isProcedure(procedure)) continue;
    const def = procedure["~orpc"];
    if (!(def.meta as { mcp?: { tool?: boolean } } | undefined)?.mcp?.tool) continue;

    const input = toolInput(def.inputSchema);
    mcp.registerTool(snake(key), {
      description: def.route.description,
      inputSchema: input.schema,
      annotations: { readOnlyHint: def.route.method === "GET" && key !== "loginQRCode" },
    }, async (args: Record<string, unknown>, { signal }: { signal: AbortSignal }): Promise<CallToolResult> => {
      try {
        const result: unknown = await call(
          procedure, input.wrap(args) as never, { context: {}, signal },
        );
        if (result instanceof File) {
          return { content: [{
            type: "image",
            data: Buffer.from(await result.arrayBuffer()).toString("base64"),
            mimeType: result.type || "image/png",
          }] };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (error) {
        const code = error instanceof ORPCError ? error.code : "INTERNAL_SERVER_ERROR";
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `${code}: ${message}` }],
          structuredContent: { code, message },
        };
      }
    });
  }
  return mcp;
}

/** Stateless Streamable HTTP: Quark login belongs to the drive, not MCP. */
export async function handleMcpRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = createMcpServer();
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
