// apps/server — thin process manager + CDP proxy.
//
// Implements the shared `serverContract` (packages/contract) with a typed
// oRPC implementation, exposes it as OpenAPI over Hono, and hosts the CDP
// proxy + process manager. No idle/sleep policy — that lives in apps/client.

import { Hono } from "hono";
import { implement, onError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { serverContract } from "@quark/contract/server";
import { LAUNCH_SCRIPT, QUARK_API_PORT, QUARK_AUTOSTART } from "./env.ts";
import { log } from "./logger.ts";
import { ProcessManager } from "./process.ts";
import { startCdpProxy } from "./cdp-proxy.ts";

const processManager = new ProcessManager();

// CDP proxy activity feeds back into the process manager's activity tracking,
// which apps/client consumes via /status and /events to make idle decisions.
startCdpProxy({ onActivity: () => processManager.markActivity() });

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

const router = base.router({
  healthz: base.healthz.handler(() => ({ ok: true })),

  status: base.status.handler(() => processManager.status()),

  start: base.start.handler(() => processManager.start()),
  stop: base.stop.handler(() => processManager.stop()),
  restart: base.restart.handler(() => processManager.restart()),
  minimize: base.minimize.handler(() => processManager.minimize()),
  restore: base.restore.handler(() => processManager.restore()),

  events: base.events.handler(async function* ({ signal }) {
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
  }),
});

const handler = new OpenAPIHandler(router, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "Quark Server Manager API",
          version: "1.0.0",
          description: [
            "Thin process manager for the Wine/Electron Quark Cloud Drive",
            "instance inside this container. Exposes process lifecycle,",
            "window state, and a live /events SSE stream. Idle/sleep policy",
            "is NOT here — it lives in apps/client.",
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

function start(): void {
  if (QUARK_AUTOSTART) {
    if (!processManager.launchScriptAvailable()) {
      // Local dev hosts usually lack the Wine/Quark launch script — don't
      // spam an ERROR, just skip autostart and keep the API + CDP proxy up.
      log.warn(
        `QUARK_AUTOSTART=true but launch script missing at "${LAUNCH_SCRIPT}" — ` +
          "skipping autostart. Install it, set LAUNCH_SCRIPT, or set QUARK_AUTOSTART=false.",
      );
    } else {
      processManager.start().catch((e) => log.error("autostart failed:", e));
    }
  }
  Deno.serve({ port: QUARK_API_PORT }, app.fetch);
  log.info(`server listening on :${QUARK_API_PORT}`);
  log.info("CDP proxy started");
}

if (import.meta.main) {
  start();
}

export { processManager };
