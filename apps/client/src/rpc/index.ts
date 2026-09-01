// apps/client — Hono + oRPC OpenAPI surface.

import { Hono } from "hono";
import { onError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { SERVER_PORT } from "../env.ts";
import { log } from "../logger.ts";
import { clientRouter } from "./router.ts";
import { handleMcpRequest } from "./mcp.ts";
import { vncApp } from "./vnc.ts";
import { devtoolsApp } from "./devtools.ts";
import { kvStore } from "../store/kv.ts";

const handler = new OpenAPIHandler(clientRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "Quark Remote Client API",
          version: "1.0.0",
          description: [
            "Programmatic interface to a headless Quark Cloud Drive client",
            "driven over CDP via Playwright. Long operations (list_file,",
            "download_file, import_share_link) stream SSE progress; short",
            "queries return plain JSON.",
          ].join("\n"),
        },
      },
    }),
  ],
  interceptors: [
    onError((error) => {
      log.error("oRPC error:", error);
    }),
  ],
});

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

// Internal ops: recently recorded task history (not part of the oRPC contract
// — read-only convenience for debugging/ops).
app.get("/history", async (c) => {
  const tasks = await kvStore.listTasks(50);
  return c.json({ tasks });
});

// MCP over Streamable HTTP (stateless WebStandard transport).
app.all("/mcp", (c) => handleMcpRequest(c.req.raw));

// noVNC page + WebSocket→VNC proxy (server only exposes the raw VNC port).
app.route("/", vncApp);

// Chrome DevTools page + WebSocket bridge to the CDP proxy (server:9223).
app.route("/", devtoolsApp);

app.use("/*", async (c, next) => {
  const { matched, response } = await handler.handle(c.req.raw, {
    context: {},
  });
  if (matched) return c.newResponse(response.body, response);
  await next();
});

export function startServer(): void {
  Deno.serve({ port: SERVER_PORT }, app.fetch);
  log.debug(`oRPC/Hono server listening on port ${SERVER_PORT}`);
  log.debug(`API docs: http://localhost:${SERVER_PORT}/`);
  log.debug(`OpenAPI spec: http://localhost:${SERVER_PORT}/spec.json`);
}
