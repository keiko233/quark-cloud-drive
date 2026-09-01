import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import {
  BrowserQueueStatusSchema,
  ClientEventSchema,
  DownloadFileStreamEventSchema,
  FileListStreamEventSchema,
  ImportShareLinkStreamEventSchema,
  QuarkDownloadFileResultSchema,
  QuarkDownloadStatusModeSchema,
  QuarkDownloadStatusSchema,
  QuarkDownloadTaskOperationSchema,
  QuarkFileListSchema,
  QuarkImportShareLinkResultSchema,
  QuarkSetDownloadStatusResultSchema,
} from "./schemas.ts";

/**
 * apps/client contract — the orchestration + business surface.
 *
 * Long operations (`downloadFile`, `getFileList`, `importShareLink`) are SSE
 * streams: they yield progress events and terminate with the final result.
 * Short queries stay plain JSON. `/events` is a global event bus (queue +
 * process + monitor + operation events).
 */
export const clientContract = oc.router({
  version: oc.route({
    method: "GET",
    path: "/version",
    description: [
      "Return the Chromium build that Quark is running on (via CDP",
      "`Browser.getVersion`). Quick liveness check.",
    ].join("\n"),
  }).output(z.object({ version: z.string() })),

  queueStatus: oc.route({
    method: "GET",
    path: "/get-queue-status",
    description: [
      "Snapshot of the in-process operation queue (single-slot serialization",
      "over the one Quark window). `{running, current, queued, total}`.",
    ].join("\n"),
  }).output(BrowserQueueStatusSchema),

  events: oc.route({
    method: "GET",
    path: "/events",
    description: [
      "SSE event bus: queue status changes, mirrored server process",
      "transitions, monitor (idle/sleep) decisions, and operation",
      "lifecycle events.",
    ].join("\n"),
  }).output(eventIterator(ClientEventSchema)),

  getLoginQRCode: oc.route({
    method: "GET",
    path: "/get-login-qrcode",
    description: "Capture the Quark login QR code as a PNG image.",
  }).output(z.instanceof(File)),

  getLoginStatus: oc.route({
    method: "GET",
    path: "/get-login-status",
    description: "Check whether the user is currently logged in to Quark.",
  }).output(z.object({ loggedIn: z.boolean() })),

  getUserInfo: oc.route({
    method: "GET",
    path: "/get-user-info",
    description: [
      "Return basic account info — currently just the storage capacity",
      "string rendered on the home page.",
    ].join("\n"),
  }).output(z.object({ capacity: z.string() })),

  getFileList: oc.route({
    method: "GET",
    path: "/get-file-list",
    inputStructure: "detailed",
    description: [
      "List files/folders in a directory. SSE stream yielding",
      "`collecting` progress events; the final value is the full",
      "`{path, items}` list (virtual scroll is exhausted).",
    ].join("\n"),
  })
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
    .input(z.object({ query: z.object({ path: z.string() }) }))
    .output(
      eventIterator(
        DownloadFileStreamEventSchema,
        QuarkDownloadFileResultSchema,
      ),
    ),

  getDownloadStatus: oc.route({
    method: "GET",
    path: "/get-download-status",
    inputStructure: "detailed",
    description:
      "Read Quark's transport center rows (`running`/`complete`/`all`).",
  })
    .input(z.object({
      query: z.object({
        status: QuarkDownloadStatusModeSchema.optional(),
      }).optional(),
    }))
    .output(QuarkDownloadStatusSchema),

  setDownloadStatus: oc.route({
    method: "POST",
    path: "/set-download-status",
    inputStructure: "detailed",
    description:
      "`resume` / `pause` / `delete` a single transport-center task.",
  })
    .input(z.object({
      body: z.object({
        taskName: z.string(),
        operation: QuarkDownloadTaskOperationSchema,
      }),
    }))
    .output(QuarkSetDownloadStatusResultSchema),

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
    .input(z.object({ body: z.object({ url: z.string() }) }))
    .output(
      eventIterator(
        ImportShareLinkStreamEventSchema,
        QuarkImportShareLinkResultSchema,
      ),
    ),
});
