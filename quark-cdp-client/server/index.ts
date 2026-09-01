import { Hono } from "hono";
import { onError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { SERVER_PORT } from "../libs/env.ts";
import { log } from "../libs/logger.ts";
import { router } from "./router.ts";
import { setupMcpRoute } from "./mcp.ts";
import { wakeOnRequest } from "./wake-middleware.ts";

const app = new Hono();

// Wake-on-request goes first: every business request hits the manager /start
// (idempotent) and waits for CDP to come back online before the oRPC handler
// runs. /manager/* and metadata routes are exempt — see wake-middleware.ts.
app.use("/*", wakeOnRequest);

setupMcpRoute(app);

const handler = new OpenAPIHandler(router, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [
        new ZodToJsonSchemaConverter(),
      ],
      specGenerateOptions: {
        info: {
          title: "Quark Remote Client API",
          version: "1.0.0",
          description: [
            "Programmatic interface to a headless Quark Cloud Drive Windows",
            "client running under Wine inside the sibling `quark-docker`",
            "container. This service drives that client over CDP via",
            "Playwright and exposes:",
            "",
            "- **Quark business actions** (`/version`, `/get-file-list`,",
            "  `/download-file`, `/get-download-status`,",
            "  `/set-download-status`, `/get-login-qrcode`,",
            "  `/get-login-status`, `/get-user-info`, `/import-share-link`).",
            "  These run inside a single-slot browser queue",
            "  (`concurrency: 1`) because all Playwright ops share the one",
            "  Quark window.",
            "- **Manager passthrough** (`/manager-status`, `/manager-start`,",
            "  `/manager-stop`, `/manager-restart`, `/manager-minimize`,",
            "  `/manager-restore`). These forward to the manager FastAPI",
            "  inside quark-docker (process lifecycle, window state, idle",
            "  policy). New manager-related routes follow the same",
            "  `/manager-<verb>` naming.",
            "",
            "**Wake-on-request.** Every business route is wrapped by a",
            "middleware that probes CDP and calls `manager-start` if Quark",
            "has been idle-stopped. The first request after idle pays a",
            "cold-start delay (a few seconds); subsequent requests are",
            "instant. `/manager-*` and `/spec.json` / `/openapi.json` are",
            "exempt from the wake (they ARE the wake / metadata).",
            "",
            "**MCP.** The same surface is also exposed as MCP tools over",
            "`POST /mcp` (tool names are snake_case mirrors of the HTTP",
            "paths). See the `tools/list` response for the live list and",
            "per-tool descriptions.",
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

app.use("/*", async (c, next) => {
  const { matched, response } = await handler.handle(c.req.raw, {
    context: {},
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  await next();
});

export function startServer(): void {
  Deno.serve({ port: SERVER_PORT }, app.fetch);
  log.debug(`oRPC/Hono server listening on port ${SERVER_PORT}`);
  log.debug(`API docs: http://localhost:${SERVER_PORT}/`);
  log.debug(`OpenAPI spec: http://localhost:${SERVER_PORT}/spec.json`);
  log.debug(`MCP endpoint: http://localhost:${SERVER_PORT}/mcp`);
}
