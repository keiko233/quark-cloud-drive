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
  userInfo: base.userInfo.handler(() => userInfo()),

  listFile: base.listFile.handler(async ({ input }) => {
    return await listFile(input.query?.path);
  }),

  downloadFile: base.downloadFile.handler(async ({ input }) => {
    return await downloadFile(input.query.path);
  }),

  downloadStatus: base.downloadStatus.handler(async ({ input }) => {
    return await downloadStatus(input.query?.status);
  }),

  updateDownloadStatus: base.updateDownloadStatus.handler(async ({ input }) => {
    return await updateDownloadStatus(
      input.body.taskName,
      input.body.operation,
    );
  }),

  importShareLink: base.importShareLink.handler(async ({ input }) => {
    return await importShareLink(input.body.url);
  }),
});
