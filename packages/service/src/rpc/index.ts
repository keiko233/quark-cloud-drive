// @quark/service — Hono + oRPC OpenAPI surface (REST + MCP + noVNC).

import { Hono } from "hono";
import { onError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { SERVER_PORT } from "@quark/config";
import { log } from "@quark/config";
import { clientRouter } from "./router.ts";
import { handleMcpRequest } from "./mcp.ts";
import { vncApp } from "./vnc.ts";
import { devtoolsApp } from "./devtools.ts";
import { resolveUpgrade, websocket } from "./ws.ts";
import { kvStore } from "@quark/drive";

const handler = new OpenAPIHandler(clientRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "Quark Cloud Drive API",
          version: "1.0.0",
          description: [
            "Programmatic interface to the Quark Cloud Drive instance in this",
            "container — process lifecycle, window control, and the drive's",
            "business API in one process.",
            "Every business endpoint is a direct call to Quark's cloud-drive",
            "JSON API, issued from the logged-in renderer; no endpoint drives",
            "the Quark UI, so business responses are plain JSON (no SSE",
            "progress streams). Locators are Quark `fid`s. Add `raw=true` to",
            "any business endpoint to include the untouched upstream fields",
            "under a `raw` object.",
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
  if (matched) {
    // Every business procedure answers with plain JSON. The only streams left
    // are the `/events` and `/manager/events` SSE buses, which pass through.
    return c.newResponse(response.body, response);
  }
  await next();
});

export function startService(): void {
  Bun.serve({
    port: SERVER_PORT,
    // The two WebSocket bridges upgrade before Hono: Bun needs `undefined`
    // back from the fetch handler for a successful upgrade, which a Hono
    // handler cannot express.
    fetch(req, server) {
      const data = resolveUpgrade(req);
      if (data) {
        if (server.upgrade(req, { data })) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      return app.fetch(req);
    },
    websocket,
  });
  log.debug(`oRPC/Hono server listening on port ${SERVER_PORT}`);
  log.debug(`API docs: http://localhost:${SERVER_PORT}/`);
  log.debug(`OpenAPI spec: http://localhost:${SERVER_PORT}/spec.json`);
}
