import { implement, ORPCError } from "@orpc/server";
import { clientContract } from "@quark/contract/client";
import type { ClientEvent } from "@quark/contract/schemas";
import {
  Channel,
  getOperationQueue,
  getRuntimeConfig,
  readLoginStateRaw,
  updateRuntimeConfig,
  listDownloads,
  getFile,
  saveShare,
  getShareImport,
  isQuarkLoginError,
  QuarkApiError,
  listFiles,
  loginStatus,
  startDownload,
  listCloudTasks,
  controlDownloads,
  controlCloudTasks,
  getAccount,
} from "@quark/drive";
import { processManager, streamManagerEvents } from "@quark/manager";
import { loginQRCode } from "../session/login-qrcode.ts";
import { sleeper } from "./runtime.ts";
import { withDriveSession } from "../guard.ts";
import {
  clearLoggedOutStopMarker,
  clearManualStop,
  getSavedRuntimeStatus,
  makeRuntimeStatus,
  markManualStop,
} from "../monitor/status.ts";

const base = implement(clientContract).use(async ({ next, errors }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (isQuarkLoginError(error)) {
      throw errors.UNAUTHORIZED({
        message: "Sign in to Quark with login_qr_code (GET /login/qrcode) and retry.",
      });
    }
    if (error instanceof QuarkApiError) {
      throw errors.BAD_GATEWAY({ message: error.message });
    }
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
    const process = await processManager.status();
    const status = await sleeper.status() ?? await getSavedRuntimeStatus();
    const config = await getRuntimeConfig();
    if (status) {
      const login = process.state === "stopped" || process.state === "starting"
        ? "unknown"
        : readLoginStateRaw();
      return makeRuntimeStatus({
        process,
        login,
        runningTasks: status.tasks.running,
        tasksCheckedAt: status.tasks.checkedAt,
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
      runningTasks: null,
      tasksCheckedAt: null,
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

    unsubscribes.push(processManager.events.subscribe("process", ({ state }) =>
      merged.push({ type: "process", state, source: "server" })
    ));
    const onAbort = () => merged.close();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    try {
      while (true) {
        const event = await merged.recv();
        if (event === null) break;
        yield event;
      }
    } finally {
      merged.close();
      for (const unsub of unsubscribes) unsub();
      signal?.removeEventListener("abort", onAbort);
    }
  }),

  loginQRCode: base.loginQRCode.handler(async ({ signal }) => {
    const bytes = await loginQRCode(signal);
    return new File([Uint8Array.from(bytes)], "login-qrcode.png", {
      type: "image/png",
    });
  }),

  loginStatus: base.loginStatus.handler(({ input }) =>
    withDriveSession(() => loginStatus(input.query), { login: false })
  ),
  getAccount: base.getAccount.handler(({ input }) =>
    withDriveSession(() => getAccount(input.query))
  ),
  listFiles: base.listFiles.handler(({ input }) =>
    withDriveSession(() => listFiles(input.query))
  ),
  getFile: base.getFile.handler(({ input }) =>
    withDriveSession(() => getFile(input.query))
  ),
  startDownload: base.startDownload.handler(({ input, signal }) =>
    withDriveSession(() => getOperationQueue().run(
      "startDownload", { signal }, () => startDownload(input.body),
    ))
  ),
  listDownloads: base.listDownloads.handler(({ input }) =>
    withDriveSession(() => listDownloads(input.query))
  ),
  controlDownloads: base.controlDownloads.handler(({ input, signal }) =>
    withDriveSession(() => getOperationQueue().run(
      "controlDownloads", { signal }, () => controlDownloads(input.body),
    ))
  ),
  listCloudTasks: base.listCloudTasks.handler(({ input }) =>
    withDriveSession(() => listCloudTasks(input.query))
  ),
  controlCloudTasks: base.controlCloudTasks.handler(({ input, signal }) =>
    withDriveSession(() => getOperationQueue().run(
      "controlCloudTasks", { signal }, () => controlCloudTasks(input.body),
    ))
  ),
  saveShare: base.saveShare.handler(({ input, signal }) =>
    withDriveSession(() => getOperationQueue().run(
      "saveShare", { signal }, () => saveShare(input.body),
    ))
  ),
  getShareImport: base.getShareImport.handler(({ input }) =>
    withDriveSession(() => getShareImport(input.query))
  ),

  manager: base.manager.router({
    status: base.manager.status.handler(() => processManager.status()),

    start: base.manager.start.handler(async () => {
      await clearManualStop();
      await clearLoggedOutStopMarker();
      sleeper.clearDecision();
      return await processManager.start();
    }),

    stop: base.manager.stop.handler(async () => {
      // An explicit stop must stick: without this marker the reconnect loop
      // would wake Quark again within seconds.
      await markManualStop();
      return await processManager.stop();
    }),

    restart: base.manager.restart.handler(async () => {
      await clearManualStop();
      await clearLoggedOutStopMarker();
      sleeper.clearDecision();
      return await processManager.restart();
    }),

    minimize: base.manager.minimize.handler(() => processManager.minimize()),

    restore: base.manager.restore.handler(() => processManager.restore()),

    events: base.manager.events.handler(async function* ({ signal }) {
      yield* streamManagerEvents(processManager, { signal });
    }),
  }),
});
