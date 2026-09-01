// ──────────────────────────────────────────────────────────────────────────────
// oRPC router. Keep API surface in sync with `server/mcp.ts`.
//
// The procedures here correspond to the MCP tools advertised by the sibling
// `server/mcp.ts` file. `server/mcp.ts` runs a startup parity check that
// throws if the two sides drift (a tool advertised but not dispatched, or a
// dispatch handler with no entry in `TOOLS`).
//
// When you add a new procedure here, also add the matching entry to
// `MCP_TOOL_HANDLERS` and `TOOLS` in `server/mcp.ts` — otherwise the server
// will refuse to start until both sides agree.
//
// `manager-*` routes are intentionally NOT mirrored to MCP — they are
// infrastructure control (process lifecycle, idle window), not Quark business
// actions. The wake-on-request middleware also skips them by path prefix.
// ──────────────────────────────────────────────────────────────────────────────

import { getBrowser, getBrowserQueueStatus } from "../client/browser.ts";
import {
  downloadFile,
  getDownloadStatus,
  getFileList,
  getLoginQRCode,
  getLoginStatus,
  getUserInfo,
  importShareLink,
  setDownloadStatus,
} from "../client/actions/index.ts";
import {
  BrowserQueueStatusSchema,
  QuarkDownloadFileResultSchema,
  QuarkDownloadStatusModeSchema,
  QuarkDownloadStatusSchema,
  QuarkDownloadTaskOperationSchema,
  QuarkFileListSchema,
} from "../libs/schemas.ts";
import { manager } from "../libs/manager.ts";
import {
  zActionResult,
  zGetStatusStatusGetResponse,
} from "../libs/manager-client/zod.gen.ts";
import z from "zod";
import { baseProcedure } from "./errors.ts";

// deno-lint-ignore no-explicit-any
function unwrap<T>(result: any): T {
  // better-result's match: ok branch returns value, err branch throws
  // deno-lint-ignore no-explicit-any
  return (result as { match: (...args: any[]) => any }).match({
    ok: (v: T) => v,
    err: (e: Error): never => {
      throw e;
    },
  }) as T;
}

// Helper for /manager/* passthrough routes: invoke a SDK function, throw on
// error so baseProcedure's INTERNAL_SERVER_ERROR wrapper produces a sensible
// HTTP response, return data on success.
async function callManager<T>(
  fn: () => Promise<{ data?: T; error?: unknown }>,
): Promise<T> {
  const { data, error } = await fn();
  if (error !== undefined) {
    throw new Error(
      typeof error === "string" ? error : JSON.stringify(error),
    );
  }
  return data as T;
}

export const router = {
  version: baseProcedure
    .route({
      method: "GET",
      path: "/version",
      description: [
        "Return the Chromium build that Quark is running on, as exposed via",
        "CDP `Browser.getVersion`. Useful as a quick liveness check — if",
        "this returns 200 with a sensible string, the wake middleware and",
        "browser connection are both healthy.",
        "",
        "Throws 500 `Browser is not connected` if Playwright has not yet",
        "attached (typical during the first ~5 s after cold-start, while",
        "the reconnect loop is establishing the CDP session).",
      ].join("\n"),
    })
    .handler(() => {
      const browser = getBrowser();
      return { version: browser.version() };
    }),

  getQueueStatus: baseProcedure
    .route({
      method: "GET",
      path: "/get-queue-status",
      description: [
        "Snapshot of the in-process browser-operation queue. Useful for",
        "rate-limiting upstream callers and diagnosing why a request is",
        "slow.",
        "",
        "All Quark-touching actions go through this single-slot queue",
        "(`concurrency: 1`) because Playwright actions share the one Quark",
        "window — interleaving them would race for focus and breadcrumbs.",
        "`running` is the in-flight op, `queued` is everything waiting,",
        "`total = queued + (running ? 1 : 0)`.",
      ].join("\n"),
    })
    .output(BrowserQueueStatusSchema)
    .handler(() => {
      return getBrowserQueueStatus();
    }),

  getLoginQRCode: baseProcedure
    .route({
      method: "GET",
      path: "/get-login-qrcode",
      description: getLoginQRCode.metadata.description,
    })
    .output(z.instanceof(File))
    .handler(async () => {
      const image = unwrap<Uint8Array>(await getLoginQRCode());
      return new File(
        [Uint8Array.from(image as Iterable<number>)],
        "login-qrcode.png",
        { type: "image/png" },
      );
    }),

  getLoginStatus: baseProcedure
    .route({
      method: "GET",
      path: "/get-login-status",
      description: getLoginStatus.metadata.description,
    })
    .output(z.object({ loggedIn: z.boolean() }))
    .handler(async () => {
      return unwrap(await getLoginStatus());
    }),

  getUserInfo: baseProcedure
    .route({
      method: "GET",
      path: "/get-user-info",
      description: getUserInfo.metadata.description,
    })
    .output(z.object({ capacity: z.string() }))
    .handler(async () => {
      return unwrap(await getUserInfo());
    }),

  getFileList: baseProcedure
    .route({
      method: "GET",
      path: "/get-file-list",
      inputStructure: "detailed",
      description: getFileList.metadata.description,
    })
    .input(z.object({
      query: z.object({ path: z.string().optional() }).optional(),
    }))
    .output(QuarkFileListSchema)
    .handler(async ({ input }) => {
      return unwrap(await getFileList(input.query?.path));
    }),

  downloadFile: baseProcedure
    .route({
      method: "GET",
      path: "/download-file",
      inputStructure: "detailed",
      description: downloadFile.metadata.description,
    })
    .input(z.object({ query: z.object({ path: z.string() }) }))
    .output(QuarkDownloadFileResultSchema)
    .handler(async ({ input }) => {
      return unwrap(await downloadFile(input.query.path));
    }),

  getDownloadStatus: baseProcedure
    .route({
      method: "GET",
      path: "/get-download-status",
      inputStructure: "detailed",
      description: getDownloadStatus.metadata.description,
    })
    .input(z.object({
      query: z.object({
        status: QuarkDownloadStatusModeSchema.optional(),
      }).optional(),
    }))
    .output(QuarkDownloadStatusSchema)
    .handler(async ({ input }) => {
      return unwrap(await getDownloadStatus(input.query?.status));
    }),

  setDownloadStatus: baseProcedure
    .route({
      method: "POST",
      path: "/set-download-status",
      inputStructure: "detailed",
      description: setDownloadStatus.metadata.description,
    })
    .input(z.object({
      body: z.object({
        taskName: z.string(),
        operation: QuarkDownloadTaskOperationSchema,
      }),
    }))
    .output(z.object({ success: z.boolean() }))
    .handler(async ({ input }) => {
      return unwrap(
        await setDownloadStatus(input.body.taskName, input.body.operation),
      );
    }),

  importShareLink: baseProcedure
    .route({
      method: "POST",
      path: "/import-share-link",
      inputStructure: "detailed",
      description: importShareLink.metadata.description,
    })
    .input(z.object({
      body: z.object({
        url: z.string(),
      }),
    }))
    .output(z.object({ url: z.string(), savedPath: z.string() }))
    .handler(async ({ input }) => {
      return unwrap(await importShareLink(input.body.url));
    }),

  // ── /manager-* — quark-docker manager passthrough ──────────────────────────
  // These exist so upstream consumers (e.g. the orchestrator that calls this
  // service) can drive Quark's process lifecycle and window state without
  // talking to the manager directly. They are intentionally skipped by the
  // wake-on-request middleware (they ARE the wake control surface).
  //
  // Naming convention: NEW manager-related routes go under `/manager-<verb>`
  // (kebab-case, dash-joined), NOT `/manager/<verb>`. The flat namespace keeps
  // a single source of truth for the wake-skip prefix (see wake-middleware.ts)
  // and makes the spec-generated SDK names read naturally
  // (`postManagerStart` vs `postManagerStartPost`). Apply this for any future
  // /manager-* route or other passthrough-style infrastructure surfaces.

  managerStatus: baseProcedure
    .route({
      method: "GET",
      path: "/manager-status",
      description:
        "Snapshot of the manager process state, CPU, idle timers, and counts.",
    })
    .output(zGetStatusStatusGetResponse)
    .handler(async () => {
      return await callManager(() => manager.status());
    }),

  managerStart: baseProcedure
    .route({
      method: "POST",
      path: "/manager-start",
      description:
        "Start Quark (or restore from minimized). Idempotent — safe to call when already running.",
    })
    .output(zActionResult)
    .handler(async () => {
      return await callManager(() => manager.start());
    }),

  managerStop: baseProcedure
    .route({
      method: "POST",
      path: "/manager-stop",
      description: "Stop Quark and free its process group. Idempotent.",
    })
    .output(zActionResult)
    .handler(async () => {
      return await callManager(() => manager.stop());
    }),

  managerRestart: baseProcedure
    .route({
      method: "POST",
      path: "/manager-restart",
      description: "Stop then start. Useful after settings changes.",
    })
    .output(zActionResult)
    .handler(async () => {
      return await callManager(() => manager.restart());
    }),

  managerMinimize: baseProcedure
    .route({
      method: "POST",
      path: "/manager-minimize",
      description:
        "Minimize the Quark window — keeps the process alive but lets Chromium throttle to free CPU.",
    })
    .output(zActionResult)
    .handler(async () => {
      return await callManager(() => manager.minimize());
    }),

  managerRestore: baseProcedure
    .route({
      method: "POST",
      path: "/manager-restore",
      description: "Restore the minimized Quark window.",
    })
    .output(zActionResult)
    .handler(async () => {
      return await callManager(() => manager.restore());
    }),
};
