import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { sharedErrorMap } from "./errors.ts";
import {
  ClientEventSchema,
  QuarkDownloadControlResultSchema,
  QuarkDownloadOperationSchema,
  QuarkDownloadQueueSchema,
  QuarkDownloadStartResultSchema,
  QuarkFileInfoSchema,
  QuarkFileListSchema,
  QuarkShareImportSchema,
  QuarkShareSubmissionSchema,
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

/** Shared REST contract. Only drive and sign-in procedures opt into MCP. */
export const clientContract = oc.errors(sharedErrorMap).router({
  config: oc.route({
    method: "GET",
    path: "/config",
    description: "Read the persisted idle monitor settings.",
  }).output(RuntimeConfigSchema),

  updateConfig: oc.route({
    method: "PATCH",
    path: "/config",
    inputStructure: "detailed",
    description: "Patch and persist idle monitor settings.",
  })
    .input(z.object({ body: RuntimeConfigPatchSchema }))
    .output(RuntimeConfigSchema),

  status: oc.route({
    method: "GET",
    path: "/status",
    description: [
      "Quantified runtime status: process, login renderer, cloud tasks,",
      "operation queue, health score, monitor decision, and guard state.",
    ].join("\n"),
  }).output(RuntimeStatusSchema),

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
    path: "/login/qrcode",
    description: [
      "Capture the Quark sign-in QR code as a PNG image. " +
      "Use when login_status reports the account is signed out.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .output(z.instanceof(File)),

  loginStatus: oc.route({
    method: "GET",
    path: "/login/status",
    inputStructure: "detailed",
    description: [
      "Probe Quark's authenticated member API to report whether the session",
      "is logged in. `loggedIn` is false when Quark answers 401/`31001`.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({ raw: RawOptionSchema }).optional(),
    }))
    .output(QuarkLoginStatusSchema),

  getAccount: oc.route({
    method: "GET",
    path: "/account",
    inputStructure: "detailed",
    description: [
      "Read the signed-in account's used and total capacity.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({ raw: RawOptionSchema }).optional(),
    }))
    .output(QuarkUserInfoSchema),

  listFiles: oc.route({
    method: "GET",
    path: "/files",
    inputStructure: "detailed",
    description: [
      "List a folder straight from Quark's JSON file API. `fid` is the only",
      "locator; it defaults to the drive root `0`, and every item carries its",
      "own `fid`.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({
        fid: z.string().trim().min(1).optional(),
        raw: RawOptionSchema,
      }).strict().optional(),
    }))
    .output(QuarkFileListSchema),

  getFile: oc.route({
    method: "GET",
    path: "/files/info",
    inputStructure: "detailed",
    description: [
      "Resolve one file or folder by `fid` via Quark's file/info API: name,",
      "parent `dirFid`, size, type, and modification time.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({ fid: z.string().trim().min(1), raw: RawOptionSchema })
        .strict(),
    }))
    .output(QuarkFileInfoSchema),

  startDownload: oc.route({
    method: "POST",
    path: "/downloads",
    inputStructure: "detailed",
    description:
      "Queue a file or an entire folder by fid in the local Downloads directory. " +
      "This returns a task ID when queued; use list_downloads with that ID and " +
      "wait for status=finish before treating the file as available.",
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      body: z.object({ fid: z.string().trim().min(1), raw: RawOptionSchema }).strict(),
    }))
    .output(QuarkDownloadStartResultSchema),

  listDownloads: oc.route({
    method: "GET",
    path: "/downloads",
    inputStructure: "detailed",
    description:
      "List local transfers and their progress, destination and errors. " +
      "Pass the taskId returned by start_download to track one transfer.",
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({
        taskId: z.string().trim().min(1).optional(),
        raw: RawOptionSchema,
      }).strict().optional(),
    }))
    .output(QuarkDownloadQueueSchema),

  controlDownloads: oc.route({
    method: "PATCH",
    path: "/downloads",
    inputStructure: "detailed",
    description: [
      "Pause, resume or cancel local downloads by `taskIds`. `cancel` also",
      "removes the task from the app's list. Partial cleanup is best effort.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      body: z.object({
        taskIds: z.array(z.string().trim().min(1)).min(1),
        operation: QuarkDownloadOperationSchema,
        raw: RawOptionSchema,
      }),
    }))
    .output(QuarkDownloadControlResultSchema),

  listCloudTasks: oc.route({
    method: "GET",
    path: "/cloud-tasks",
    inputStructure: "detailed",
    description: [
      "Read Quark's cloud tasks (offline downloads, cloud saves, unzips,",
      "uploads) with per-status counts. Use list_downloads for local transfers.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({
        status: QuarkTaskStatusFilterSchema.optional(),
        type: z.string().trim().min(1).optional(),
        size: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().trim().min(1).optional(),
        raw: RawOptionSchema,
      }).strict().optional(),
    }))
    .output(QuarkTaskListSchema),

  controlCloudTasks: oc.route({
    method: "PATCH",
    path: "/cloud-tasks",
    inputStructure: "detailed",
    description: [
      "`resume` (also retries) or `delete` one or more cloud tasks by",
      "`taskIds`. These are cloud tasks, separate from local downloads.",
    ].join("\n"),
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      body: z.object({
        taskIds: z.array(z.string().trim().min(1)).min(1),
        operation: QuarkTaskOperationSchema,
        raw: RawOptionSchema,
      }),
    }))
    .output(QuarkUpdateTaskResultSchema),

  saveShare: oc.route({
    method: "POST",
    path: "/share-imports",
    inputStructure: "detailed",
    description:
      "Submit a Quark share to be saved into your cloud drive. " +
      "Use a pan.quark.cn share URL or a share ID, with optional passcode " +
      "and destination folder fid (defaults to 来自：分享; use 0 for root). " +
      "The returned task is only submitted. Check get_share_import to confirm completion.",
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      body: z.object({
        url: QuarkShareUrlSchema,
        passcode: z.string().trim().min(1).optional(),
        toFid: z.string().trim().min(1).optional(),
      }).strict(),
    }))
    .output(QuarkShareSubmissionSchema),

  getShareImport: oc.route({
    method: "GET",
    path: "/share-imports",
    inputStructure: "detailed",
    description:
      "Check a share save using the task ID from save_share. " +
      "Only status=completed confirms the save. savedFids contains IDs reported by Quark.",
  })
    .meta({ mcp: { tool: true } })
    .input(z.object({
      query: z.object({
        taskId: z.string().trim().min(1),
        retryIndex: z.coerce.number().int().min(0).optional().describe(
          "Use nextRetryIndex from the previous poll; omit on the first poll.",
        ),
      }).strict(),
    }))
    .output(QuarkShareImportSchema),

  // HTTP-only operator controls.
  manager: oc.errors(sharedErrorMap).router({
    status: oc.route({
      method: "GET",
      path: "/manager/status",
      description: [
        "Snapshot of the Quark process state: state, tracked PID, CDP",
        "liveness, last CDP activity, and lifecycle counters.",
      ].join("\n"),
    })
      .output(ServerStatusSchema),

    start: oc.route({
      method: "POST",
      path: "/manager/start",
      description: [
        "Start Quark (or restore it from minimized). Idempotent — safe to",
        "call when already running. Returns the current launch state.",
      ].join("\n"),
    })
      .output(ServerStatusSchema),

    stop: oc.route({
      method: "POST",
      path: "/manager/stop",
      description: "Stop Quark and free its process group. Idempotent.",
    })
      .output(ServerStatusSchema),

    restart: oc.route({
      method: "POST",
      path: "/manager/restart",
      description: "Stop then start. Useful after settings changes.",
    })
      .output(ServerStatusSchema),

    minimize: oc.route({
      method: "POST",
      path: "/manager/minimize",
      description: [
        "Minimize the Quark window (X unmap) — keeps the process alive but",
        "lets Chromium throttle to free CPU.",
      ].join("\n"),
    })
      .output(ServerStatusSchema),

    restore: oc.route({
      method: "POST",
      path: "/manager/restore",
      description: "Restore the minimized Quark window (X map).",
    })
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
