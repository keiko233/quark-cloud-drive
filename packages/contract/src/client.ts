import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { sharedErrorMap } from "./errors.ts";
import {
  BrowserQueueStatusSchema,
  ClientEventSchema,
  DownloadFileStreamEventSchema,
  FileListStreamEventSchema,
  HealthzSchema,
  ImportShareLinkStreamEventSchema,
  QuarkDownloadFileResultSchema,
  QuarkDownloadStatusModeSchema,
  QuarkDownloadStatusSchema,
  QuarkDownloadTaskOperationSchema,
  QuarkFileListSchema,
  QuarkImportShareLinkResultSchema,
  QuarkUpdateDownloadStatusResultSchema,
  ServerEventSchema,
  ServerStatusSchema,
} from "./schemas.ts";

/**
 * apps/client contract — the orchestration + business surface.
 *
 * Long operations (`downloadFile`, `listFile`, `importShareLink`) are SSE
 * streams: they yield progress events and terminate with the final result.
 * Short queries stay plain JSON. `/events` is a global event bus (queue +
 * process + monitor + operation events).
 *
 * Naming: procedures avoid `get_`/`set_` prefixes where the HTTP method is
 * sufficient (`listFile`, `loginStatus`, `downloadStatus`). `/download-status`
 * is a single resource: GET reads the transport center, POST mutates a task.
 */
export const clientContract = oc.errors(sharedErrorMap).router({
  version: oc.route({
    method: "GET",
    path: "/version",
    description: [
      "Return the Chromium build that Quark is running on (via CDP",
      "`Browser.getVersion`). Quick liveness check.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .output(z.object({ version: z.string() })),

  queueStatus: oc.route({
    method: "GET",
    path: "/queue-status",
    description: [
      "Snapshot of the in-process operation queue (single-slot serialization",
      "over the one Quark window). `{running, current, queued, total}`.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .output(BrowserQueueStatusSchema),

  events: oc.route({
    method: "GET",
    path: "/events",
    description: [
      "SSE event bus: queue status changes, mirrored server process",
      "transitions, monitor (idle/sleep) decisions, and operation",
      "lifecycle events.",
    ].join("\n"),
  }).output(eventIterator(ClientEventSchema)),

  loginQRCode: oc.route({
    method: "GET",
    path: "/login-qrcode",
    description: "Capture the Quark login QR code as a PNG image.",
  })
    .meta({ mcp: { tool: true } })
    .output(z.instanceof(File)),

  loginStatus: oc.route({
    method: "GET",
    path: "/login-status",
    description: "Check whether the user is currently logged in to Quark.",
  })
    .meta({ mcp: { tool: true } })
    .output(z.object({ loggedIn: z.boolean() })),

  userInfo: oc.route({
    method: "GET",
    path: "/user-info",
    description: [
      "Return basic account info — currently just the storage capacity",
      "string rendered on the home page.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .output(z.object({ capacity: z.string() })),

  listFile: oc.route({
    method: "GET",
    path: "/list-file",
    inputStructure: "detailed",
    description: [
      "List files/folders in a directory. SSE stream yielding",
      "`collecting` progress events; the final value is the full",
      "`{path, items}` list (virtual scroll is exhausted).",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({ path: z.string().optional() }).optional(),
    }))
    .output(eventIterator(FileListStreamEventSchema, QuarkFileListSchema)),

  downloadFile: oc.route({
    method: "GET",
    path: "/download-file",
    inputStructure: "detailed",
    description: [
      "Trigger a download for a file OR folder. SSE stream yielding",
      "`navigating`/`clicking` progress; the final value is",
      "`{name, alreadyQueued?}`.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({ query: z.object({ path: z.string() }) }))
    .output(
      eventIterator(
        DownloadFileStreamEventSchema,
        QuarkDownloadFileResultSchema,
      ),
    ),

  // Single resource /download-status: GET reads, POST mutates.
  downloadStatus: oc.route({
    method: "GET",
    path: "/download-status",
    inputStructure: "detailed",
    description:
      "Read Quark's transport center rows (`running`/`complete`/`all`).",
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({
        status: QuarkDownloadStatusModeSchema.optional(),
      }).optional(),
    }))
    .output(QuarkDownloadStatusSchema),

  updateDownloadStatus: oc.route({
    method: "POST",
    path: "/download-status",
    inputStructure: "detailed",
    description:
      "`resume` / `pause` / `delete` a single transport-center task.",
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      body: z.object({
        taskName: z.string(),
        operation: QuarkDownloadTaskOperationSchema,
      }),
    }))
    .output(QuarkUpdateDownloadStatusResultSchema),

  importShareLink: oc.route({
    method: "POST",
    path: "/import-share-link",
    inputStructure: "detailed",
    description: [
      "Import a `https://pan.quark.cn/s/...` share link. SSE stream",
      "yielding `opening`/`saving` progress; the final value is",
      "`{url, savedPath}`.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({ body: z.object({ url: z.string() }) }))
    .output(
      eventIterator(
        ImportShareLinkStreamEventSchema,
        QuarkImportShareLinkResultSchema,
      ),
    ),

  // Manager surface — the same process/window controls apps/server exposes,
  // re-exposed through the client so API + MCP consumers can drive the Quark
  // process without talking to the manager directly. Each handler forwards to
  // the typed serverClient. `events` mirrors the server's SSE process stream.
  manager: oc.errors(sharedErrorMap).router({
    healthz: oc.route({
      method: "GET",
      path: "/manager/healthz",
      description: "Liveness probe of the upstream manager (apps/server).",
    })
      .meta({ mcp: { tool: true } })
      .output(HealthzSchema),

    status: oc.route({
      method: "GET",
      path: "/manager/status",
      description: [
        "Snapshot of the Quark process state: state, tracked PID, CDP",
        "liveness, last CDP activity, and lifecycle counters.",
      ].join("\n"),
    })
      .meta({ mcp: { tool: true } })
      .output(ServerStatusSchema),

    start: oc.route({
      method: "POST",
      path: "/manager/start",
      description: [
        "Start Quark (or restore it from minimized). Idempotent — safe to",
        "call when already running. Waits for the CDP port to come online.",
      ].join("\n"),
    })
      .meta({ mcp: { tool: true } })
      .output(ServerStatusSchema),

    stop: oc.route({
      method: "POST",
      path: "/manager/stop",
      description: "Stop Quark and free its process group. Idempotent.",
    })
      .meta({ mcp: { tool: true } })
      .output(ServerStatusSchema),

    restart: oc.route({
      method: "POST",
      path: "/manager/restart",
      description: "Stop then start. Useful after settings changes.",
    })
      .meta({ mcp: { tool: true } })
      .output(ServerStatusSchema),

    minimize: oc.route({
      method: "POST",
      path: "/manager/minimize",
      description: [
        "Minimize the Quark window (X unmap) — keeps the process alive but",
        "lets Chromium throttle to free CPU.",
      ].join("\n"),
    })
      .meta({ mcp: { tool: true } })
      .output(ServerStatusSchema),

    restore: oc.route({
      method: "POST",
      path: "/manager/restore",
      description: "Restore the minimized Quark window (X map).",
    })
      .meta({ mcp: { tool: true } })
      .output(ServerStatusSchema),

    events: oc.route({
      method: "GET",
      path: "/manager/events",
      description: [
        "SSE stream of process transitions and CDP activity from the",
        "upstream manager. Consumers use this for live status without",
        "polling /manager/status.",
      ].join("\n"),
    }).output(eventIterator(ServerEventSchema)),
  }),
});
