// apps/client — Hono + oRPC OpenAPI surface.

import { Hono } from "hono";
import { onError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { SERVER_PORT } from "../env.ts";
import { log } from "../logger.ts";
import { clientRouter } from "./router.ts";

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
            "driven over CDP via Playwright. Long operations (get_file_list,",
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
