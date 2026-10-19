// @quark/manager — the manager's HTTP surface (the shared `serverContract`,
// implemented with oRPC and exposed as OpenAPI over Hono).
//
// Kept separate from the process manager itself so the single-process runtime
// can mount it next to the business API, and so external consumers can still
// drive the manager over HTTP.

import { Hono } from "hono";
import { implement, onError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { serverContract } from "@quark/contract/server";
import type { ServerEvent } from "@quark/contract/schemas";
import { log } from "@quark/config";
import type { ProcessManager } from "./process.ts";

/**
 * Convert the manager's internal event bus into the contracted `ServerEvent`
 * stream. Shared by the HTTP route and the in-process facade so both
 * transports observe exactly the same events.
 */
export async function* streamManagerEvents(
  processManager: ProcessManager,
  { signal }: { signal?: AbortSignal },
): AsyncGenerator<ServerEvent> {
  const processIt = processManager.events.subscribe("process", { signal });
  const activityIt = processManager.events.subscribe("activity", { signal });
  try {
    while (true) {
      const next = await Promise.race([
        processIt.next().then((r) => ({ from: "process" as const, r })),
        activityIt.next().then((r) => ({ from: "activity" as const, r })),
      ]);
      if (next.r.done) break;
      if (next.from === "process") {
        yield { type: "process", state: next.r.value.state, at: Date.now() };
      } else {
        yield { type: "activity", at: next.r.value.at };
      }
    }
  } finally {
    await processIt.return?.(undefined);
    await activityIt.return?.(undefined);
  }
}

/** Implement `serverContract` against one process manager. */
export function createManagerRouter(processManager: ProcessManager) {
  const base = implement(serverContract).use(async ({ next, errors }) => {
    try {
      return await next();
    } catch (error) {
      // Re-throw oRPC errors as-is; wrap everything else as a 500.
      if (typeof (error as { code?: unknown }).code === "string") throw error;
      throw errors.INTERNAL_SERVER_ERROR({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return base.router({
    healthz: base.healthz.handler(() => ({ ok: true })),

    status: base.status.handler(() => processManager.status()),

    start: base.start.handler(() => processManager.start()),
    stop: base.stop.handler(() => processManager.stop()),
    restart: base.restart.handler(() => processManager.restart()),
    minimize: base.minimize.handler(() => processManager.minimize()),
    restore: base.restore.handler(() => processManager.restore()),

    events: base.events.handler(async function* ({ signal }) {
      yield* streamManagerEvents(processManager, { signal });
    }),
  });
}

/** The manager's standalone Hono app (REST + OpenAPI + `/healthz`). */
export function createManagerApp(processManager: ProcessManager): Hono {
  const handler = new OpenAPIHandler(createManagerRouter(processManager), {
    plugins: [
      new OpenAPIReferencePlugin({
        schemaConverters: [new ZodToJsonSchemaConverter()],
        specGenerateOptions: {
          info: {
            title: "Quark Manager API",
            version: "1.0.0",
            description: [
              "Process lifecycle for the Wine/Electron Quark Cloud Drive",
              "instance: process state, window state, and a live /events SSE",
              "stream. Idle/sleep policy is NOT here — it lives in",
              "@quark/service.",
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

  return app;
}
