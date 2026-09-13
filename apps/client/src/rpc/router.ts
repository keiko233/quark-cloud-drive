// Implementation of the shared clientContract (packages/contract). All
// business actions run through the single-slot OperationQueue; long operations
// stream SSE progress.

import { implement } from "@orpc/server";
import { clientContract } from "@quark/contract/client";
import type { ClientEvent } from "@quark/contract/schemas";
import {
  downloadFile,
  downloadStatus,
  importShareLink,
  listFile,
  loginQRCode,
  loginStatus,
  updateDownloadStatus,
  userInfo,
} from "../actions/index.ts";
import { getBrowser, getOperationQueue } from "../browser/context.ts";
import { Channel } from "../queue/operation-queue.ts";
import { serverClient } from "../server-client/index.ts";
import { sleeper } from "./runtime.ts";
import { assertOperationAllowed } from "../guard.ts";
import { getRuntimeConfig, updateRuntimeConfig } from "../store/config.ts";
import {
  clearLoggedOutStopMarker,
  getSavedRuntimeStatus,
  makeRuntimeStatus,
} from "../monitor/status.ts";
import { readLoginStateRaw } from "../actions/login-status.ts";

const base = implement(clientContract).use(async ({ next, errors }) => {
  try {
    return await next();
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === "string") throw error;
    throw errors.INTERNAL_SERVER_ERROR({
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export const clientRouter = base.router({
  config: base.config.handler(() => getRuntimeConfig()),

  updateConfig: base.updateConfig.handler(({ input }) =>
    updateRuntimeConfig(input.body)
  ),

  status: base.status.handler(async () => {
    const process = await serverClient.status();
    const status = await sleeper.status() ?? await getSavedRuntimeStatus();
    const config = await getRuntimeConfig();
    if (status) {
      const login = process.state === "stopped" || process.state === "starting"
        ? "unknown"
        : readLoginStateRaw();
      return makeRuntimeStatus({
        process,
        login,
        runningDownloads: status.downloads.running,
        downloadsCheckedAt: status.downloads.checkedAt,
        queue: getOperationQueue().status(),
        idleForMs: status.idleForMs,
        config,
        lastCheckAt: status.monitor.lastCheckAt,
        nextCheckAt: status.monitor.nextCheckAt,
        lastDecision: status.monitor.lastDecision,
        lastReason: status.monitor.lastReason,
        lastError: status.lastError,
      });
    }
    return makeRuntimeStatus({
      process,
      login: readLoginStateRaw(),
      runningDownloads: null,
      downloadsCheckedAt: null,
      queue: getOperationQueue().status(),
      idleForMs: 0,
      config,
      lastCheckAt: null,
      nextCheckAt: null,
      lastDecision: null,
      lastReason: null,
      lastError: null,
    });
  }),

  version: base.version.handler(() => ({ version: getBrowser().version() })),

  queueStatus: base.queueStatus.handler(() => getOperationQueue().status()),

  events: base.events.handler(async function* ({ signal }) {
    // Merge every event source into one channel, then relay it out as SSE.
    const merged = new Channel<ClientEvent>();
    const unsubscribes = [
      getOperationQueue().events.subscribe(
        "change",
        (e) => merged.push({ type: "queue", status: e.status }),
      ),
      getOperationQueue().events.subscribe(
        "operation",
        (e) =>
          merged.push({ type: "operation", key: e.key ?? "", phase: e.phase }),
      ),
      sleeper.events.subscribe("decision", (e) => {
        if (e.action === "none") return;
        merged.push({
          type: "monitor",
          decision: e.action,
          reason: e.reason,
        });
      }),
      sleeper.events.subscribe(
        "status",
        (e) => merged.push({ type: "status", status: e.status }),
      ),
    ];

    // Mirror the server's process stream into the same channel.
    const serverEvents = await serverClient.events({ signal });
    const mirrorServer = (async () => {
      try {
        for await (const ev of serverEvents) {
          if (ev.type !== "process") continue;
          merged.push({ type: "process", state: ev.state, source: "server" });
        }
      } catch {
        // server stream ended/aborted
      }
    })();

    try {
      while (true) {
        const event = await merged.recv();
        if (event === null) break;
        yield event;
      }
    } finally {
      merged.close();
      for (const unsub of unsubscribes) unsub();
      await mirrorServer.catch(() => {});
    }
  }),

  loginQRCode: base.loginQRCode.handler(async () => {
    const bytes = await loginQRCode();
    return new File([Uint8Array.from(bytes)], "login-qrcode.png", {
      type: "image/png",
    });
  }),

  loginStatus: base.loginStatus.handler(() => loginStatus()),
  userInfo: base.userInfo.handler(async () => {
    await assertOperationAllowed("userInfo");
    return await userInfo();
  }),

  listFile: base.listFile.handler(async ({ input }) => {
    await assertOperationAllowed("listFile");
    return await listFile(input.query?.path);
  }),

  downloadFile: base.downloadFile.handler(async ({ input }) => {
    await assertOperationAllowed("downloadFile");
    return await downloadFile(input.query.path);
  }),

  downloadStatus: base.downloadStatus.handler(async ({ input }) => {
    await assertOperationAllowed("downloadStatus");
    return await downloadStatus(input.query?.status);
  }),

  updateDownloadStatus: base.updateDownloadStatus.handler(async ({ input }) => {
    await assertOperationAllowed("updateDownloadStatus");
    return await updateDownloadStatus(
      input.body.taskName,
      input.body.operation,
    );
  }),

  importShareLink: base.importShareLink.handler(async ({ input }) => {
    await assertOperationAllowed("importShareLink");
    return await importShareLink(input.body.url);
  }),

  // Manager surface — thin forwards to apps/server via the typed serverClient.
  // Enables API + MCP consumers to control the Quark process through the client.
  manager: base.manager.router({
    healthz: base.manager.healthz.handler(() => serverClient.healthz()),

    status: base.manager.status.handler(() => serverClient.status()),

    start: base.manager.start.handler(async () => {
      await clearLoggedOutStopMarker();
      sleeper.clearDecision();
      return await serverClient.start();
    }),

    stop: base.manager.stop.handler(() => serverClient.stop()),

    restart: base.manager.restart.handler(() => serverClient.restart()),

    minimize: base.manager.minimize.handler(() => serverClient.minimize()),

    restore: base.manager.restore.handler(() => serverClient.restore()),

    events: base.manager.events.handler(async function* ({ signal }) {
      const serverEvents = await serverClient.events({ signal });
      yield* serverEvents;
    }),
  }),
});
