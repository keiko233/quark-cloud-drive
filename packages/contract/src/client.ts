import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { sharedErrorMap } from "./errors.ts";
import {
  BrowserQueueStatusSchema,
  ClientEventSchema,
  HealthzSchema,
  QuarkDownloadControlResultSchema,
  QuarkDownloadFileResultSchema,
  QuarkDownloadOperationSchema,
  QuarkDownloadQueueSchema,
  QuarkDownloadStartResultSchema,
  QuarkFileInfoSchema,
  QuarkFileListSchema,
  QuarkImportShareLinkResultSchema,
  QuarkLoginStatusSchema,
  QuarkShareUrlSchema,
  QuarkTaskListSchema,
  QuarkTaskOperationSchema,
  QuarkTaskStatusFilterSchema,
  QuarkUpdateTaskResultSchema,
  QuarkUserInfoSchema,
  RawOptionSchema,
  RuntimeConfigPatchSchema,
  RuntimeConfigSchema,
  RuntimeStatusSchema,
  ServerEventSchema,
  ServerStatusSchema,
} from "./schemas.ts";

/**
 * @quark/service contract — the orchestration + business surface.
 *
 * Every business procedure is a direct call to Quark's cloud-drive JSON API,
 * issued inside the logged-in renderer. Nothing drives the Quark UI: there is
 * no DOM navigation, no virtual scrolling, and no click automation, so long
 * write operations are plain JSON too (no SSE progress streams).
 *
 * Locators are always Quark `fid`s. The drive root is `fid=0`. Results never
 * carry a provenance `source` because there is only one path. Every business
 * response accepts `raw=true` to add the untouched Quark payload under `raw`.
 *
 * Naming: procedures avoid `get_`/`set_` prefixes where the HTTP method is
 * sufficient (`listFile`, `taskList`, `loginStatus`). `/task-list` is a single
 * resource: GET reads Quark's cloud task list, POST mutates tasks.
 */
export const clientContract = oc.errors(sharedErrorMap).router({
  config: oc.route({
    method: "GET",
    path: "/config",
    description: "Read the persisted monitor and guard configuration.",
  }).meta({ mcp: { tool: true } }).output(RuntimeConfigSchema),

  updateConfig: oc.route({
    method: "PATCH",
    path: "/config",
    inputStructure: "detailed",
    description: "Patch and persist monitor/guard configuration.",
  }).meta({ mcp: { tool: true } })
    .input(z.object({ body: RuntimeConfigPatchSchema }))
    .output(RuntimeConfigSchema),

  status: oc.route({
    method: "GET",
    path: "/status",
    description: [
      "Quantified runtime status: process, login renderer, cloud tasks,",
      "operation queue, health score, monitor decision, and guard state.",
    ].join("\n"),
  }).meta({ mcp: { tool: true } }).output(RuntimeStatusSchema),

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
    description: [
      "Capture the Quark login QR code as a PNG image. This is the one",
      "endpoint that still reads the login window: the QR code is rendered",
      "client-side and has no JSON API.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .output(z.instanceof(File)),

  loginStatus: oc.route({
    method: "GET",
    path: "/login-status",
    inputStructure: "detailed",
    description: [
      "Probe Quark's authenticated member API to report whether the session",
      "is logged in. `loggedIn` is false when Quark answers 401/`31001`.",
      "Set `raw=true` for the untouched member payload.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({ raw: RawOptionSchema }).optional(),
    }))
    .output(QuarkLoginStatusSchema),

  userInfo: oc.route({
    method: "GET",
    path: "/user-info",
    inputStructure: "detailed",
    description: [
      "Read account capacity from Quark's member API. Set `raw=true` for the",
      "untouched member payload.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({ raw: RawOptionSchema }).optional(),
    }))
    .output(QuarkUserInfoSchema),

  listFile: oc.route({
    method: "GET",
    path: "/list-file",
    inputStructure: "detailed",
    description: [
      "List a folder straight from Quark's JSON file API. `fid` is the only",
      "locator; it defaults to the drive root `0`, and every item carries its",
      "own `fid`. Set `raw=true` to include the untouched API items and page",
      "metadata.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({
        fid: z.string().min(1).optional(),
        raw: RawOptionSchema,
      }).strict().optional(),
    }))
    .output(QuarkFileListSchema),

  fileInfo: oc.route({
    method: "GET",
    path: "/file-info",
    inputStructure: "detailed",
    description: [
      "Resolve one file or folder by `fid` via Quark's file/info API: name,",
      "parent `dirFid`, size, type, and mtime. Set `raw=true` for the",
      "untouched entry.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({ fid: z.string().min(1), raw: RawOptionSchema })
        .strict(),
    }))
    .output(QuarkFileInfoSchema),

  downloadFile: oc.route({
    method: "GET",
    path: "/download-file",
    inputStructure: "detailed",
    description: [
      "Ask Quark for fresh signed download URLs for one `fid`. A file resolves",
      "through `/file/download`. A folder is scanned through `/download/list`",
      "and returns its flattened file list, each file with its own URL",
      "(`limit` bounds how many URLs are resolved). Set `raw=true` for the",
      "action payload.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({
        fid: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(5_000).optional(),
        raw: RawOptionSchema,
      }).strict(),
    }))
    .output(QuarkDownloadFileResultSchema),

  // POST on the same path: GET resolves signed URLs, POST actually starts a
  // local download through the Quark app's own transfer engine.
  startDownload: oc.route({
    method: "POST",
    path: "/download-file",
    inputStructure: "detailed",
    description: [
      "Actually download one `fid` to disk: hand it to the Quark app's",
      "built-in downloader, which writes into the app's Downloads folder (or",
      "`toDir`) and keeps a resumable `.qkdownloading` partial until it",
      "finishes. Track it with GET /download-task. Use GET /download-file",
      "instead when you only want signed URLs and no disk write. Set",
      "`raw=true` for the action payload.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      body: z.object({
        fid: z.string().min(1),
        toDir: z.string().min(1).optional().describe(
          "Destination directory as the app sees it (Windows-style under " +
            "Wine). Defaults to the app's own Downloads folder.",
        ),
        raw: RawOptionSchema,
      }),
    }))
    .output(QuarkDownloadStartResultSchema),

  downloadTaskList: oc.route({
    method: "GET",
    path: "/download-task",
    inputStructure: "detailed",
    description: [
      "Read the local download queue — transfers started by",
      "POST /download-file that are running, paused, failed or finished, each",
      "with progress, speed and destination path. This is the app's own",
      "engine, not Quark's cloud task list (`GET /task-list`). Set `raw=true`",
      "for the untouched task objects.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({ raw: RawOptionSchema }).strict().optional(),
    }))
    .output(QuarkDownloadQueueSchema),

  updateDownloadTask: oc.route({
    method: "POST",
    path: "/download-task",
    inputStructure: "detailed",
    description: [
      "Pause, resume or cancel local downloads by `taskIds`. `cancel` also",
      "removes the task from the app's list and deletes the leftover",
      "`.qkdownloading` partial. Set `raw=true` for the action payload.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      body: z.object({
        taskIds: z.array(z.string().min(1)).min(1),
        operation: QuarkDownloadOperationSchema,
        raw: RawOptionSchema,
      }),
    }))
    .output(QuarkDownloadControlResultSchema),

  // Single resource /task-list: GET reads Quark's cloud task list, POST
  // applies an operation to one or more tasks.
  taskList: oc.route({
    method: "GET",
    path: "/task-list",
    inputStructure: "detailed",
    description: [
      "Read Quark's cloud tasks (offline downloads, cloud saves, unzips,",
      "uploads) with per-status counts. Set `raw=true` for the untouched",
      "list payload.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({
        status: QuarkTaskStatusFilterSchema.optional(),
        type: z.string().min(1).optional(),
        size: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).optional(),
        raw: RawOptionSchema,
      }).strict().optional(),
    }))
    .output(QuarkTaskListSchema),

  updateTask: oc.route({
    method: "POST",
    path: "/task-list",
    inputStructure: "detailed",
    description: [
      "`resume` (also retries) or `delete` one or more cloud tasks by",
      "`taskIds`. Set `raw=true` for the action payload.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      body: z.object({
        taskIds: z.array(z.string().min(1)).min(1),
        operation: QuarkTaskOperationSchema,
        raw: RawOptionSchema,
      }),
    }))
    .output(QuarkUpdateTaskResultSchema),

  importShareLink: oc.route({
    method: "POST",
    path: "/import-share-link",
    inputStructure: "detailed",
    description: [
      "Save a `https://pan.quark.cn/s/...` share into the drive through",
      "Quark's share API: token -> detail -> save -> task poll. `toFid`",
      "overrides the destination folder (defaults to Quark's `来自：分享`).",
      "Set `raw=true` for the action payload.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      body: z.object({
        url: QuarkShareUrlSchema,
        passcode: z.string().optional(),
        toFid: z.string().optional(),
        raw: RawOptionSchema,
      }),
    }))
    .output(QuarkImportShareLinkResultSchema),

  // Manager surface — the same process/window controls @quark/manager exposes,
  // re-exposed through this service so API + MCP consumers can drive the Quark
  // process without talking to the manager directly. Each handler forwards to
  // the typed manager client. `events` mirrors the manager's SSE process stream.
  manager: oc.errors(sharedErrorMap).router({
    healthz: oc.route({
      method: "GET",
      path: "/manager/healthz",
      description: "Liveness probe of the upstream manager (@quark/manager).",
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
