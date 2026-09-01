import { z } from "zod";

// ─── Download task primitives ────────────────────────────────────────────────
//
// "Download task" here refers to Quark's own client-side download queue — the
// items you see in the transport center inside the Quark Cloud Drive UI. It is
// NOT the same as our outer task queue (see QuarkTaskRecord below), which
// tracks the lifecycle of *our* async actions.

export const QuarkDownloadTaskStateSchema = z.enum(["running", "complete"])
  .describe(
    "Tab the task lives on inside Quark's transport center: `running` " +
      "(queued / downloading) or `complete` (finished). Quark does not " +
      "expose a separate failed state — failed downloads stay on `running`.",
  );

export const QuarkDownloadStatusModeSchema = z.enum([
  "running",
  "complete",
  "all",
]).describe(
  "Which transport-center tab(s) to read. `running` is the default " +
    "because it's the cheapest single-tab read; `all` reads both tabs.",
);

export const QuarkDownloadTaskOperationSchema = z.enum([
  "resume",
  "pause",
  "delete",
]).describe(
  "Operation to apply to a download task. `resume`/`pause` toggle " +
    "Quark's per-task control; `delete` removes the task from the " +
    "transport center (does NOT delete the downloaded file from disk).",
);

// ─── File listing ────────────────────────────────────────────────────────────

export const QuarkFileListItemSchema = z.object({
  name: z.string().describe(
    "File or folder name as Quark renders it (display name, may include " +
      "ideographs / spaces).",
  ),
  size: z.string().describe(
    "Human-readable size text scraped from the UI (e.g. `12.3MB`, " +
      "`1.2GB`, or empty for folders). Not normalized — surfaced verbatim.",
  ),
  type: z.string().describe(
    "File-type label as shown in the UI (e.g. `视频`, `文档`, `文件夹`). " +
      "Use this rather than parsing the name to distinguish folder vs file.",
  ),
  updatedAt: z.string().describe(
    "Last-modified text from the UI (e.g. `2026-06-07 12:34`). Locale " +
      "and format follow whatever Quark renders.",
  ),
});

export const QuarkFileListSchema = z.object({
  path: z.array(z.string()).describe(
    "Breadcrumb path of the directory whose contents are returned, with " +
      "the root omitted (so the array is `[]` at root).",
  ),
  items: z.array(QuarkFileListItemSchema).describe(
    "Files and folders directly under `path`, in the order Quark presents " +
      "them. The list is fetched with virtual-scroll, so every visible row " +
      "is materialised.",
  ),
});

// ─── Quark download task (transport center row) ──────────────────────────────

export const QuarkDownloadTaskSchema = z.object({
  state: QuarkDownloadTaskStateSchema,
  name: z.string().describe(
    "File/folder name as shown in the transport center row. Use this " +
      "value as the `taskName` argument to set-download-status.",
  ),
  size: z.string().describe(
    "Human-readable size text (e.g. `12.3MB`).",
  ),
  progress: z.string().describe(
    "Progress text — usually a percentage like `42%`. Empty for completed " +
      "tasks where the bar is gone.",
  ),
  speed: z.string().describe(
    "Current download speed text (e.g. `1.2MB/s`). Empty when paused or " +
      "completed.",
  ),
  remaining: z.string().describe(
    "Remaining time text (e.g. `2m30s`). Empty when paused or completed.",
  ),
  completedAt: z.string().describe(
    "Completion timestamp text — only meaningful on the `complete` tab; " +
      "empty for running tasks.",
  ),
});

export const QuarkDownloadStatusSchema = z.object({
  tasks: z.array(QuarkDownloadTaskSchema).describe(
    "All matching transport-center rows, in display order (newest first " +
      "in Quark's UI).",
  ),
});

// ─── Browser-operation queue (our internal serialization) ────────────────────

export const BrowserQueueStatusSchema = z.object({
  running: z.boolean().describe(
    "True if a browser operation is currently executing. Only ONE operation " +
      "runs at a time (concurrency=1) because Playwright actions all share " +
      "the single Quark window.",
  ),
  current: z.string().nullable().describe(
    "Label of the operation in flight, or null when idle.",
  ),
  queued: z.number().int().nonnegative().describe(
    "Number of operations waiting behind the running one.",
  ),
  total: z.number().int().nonnegative().describe(
    "queued + (running ? 1 : 0). Useful as a single congestion metric.",
  ),
});

// ─── Download submission results ─────────────────────────────────────────────

export const QuarkDownloadFileResultSchema = z.object({
  name: z.string().describe(
    "File name that was queued (last segment of the path you submitted).",
  ),
  alreadyQueued: z.boolean().optional().describe(
    "True when this file was already present in the transport center " +
      "(running or complete) and we skipped the click. Omitted on a fresh " +
      "queueing — treat absent as `false`.",
  ),
});

// (No async task-queue schemas — `download_file` is the single
// download entry point and is fully synchronous from the caller's POV.)

export type QuarkFileListItem = z.infer<typeof QuarkFileListItemSchema>;
export type QuarkFileList = z.infer<typeof QuarkFileListSchema>;
export type QuarkDownloadTask = z.infer<typeof QuarkDownloadTaskSchema>;
export type QuarkDownloadStatus = z.infer<typeof QuarkDownloadStatusSchema>;
export type QuarkDownloadTaskState = z.infer<typeof QuarkDownloadTaskStateSchema>;
export type QuarkDownloadStatusMode = z.infer<typeof QuarkDownloadStatusModeSchema>;
export type QuarkDownloadTaskOperation = z.infer<typeof QuarkDownloadTaskOperationSchema>;
export type BrowserQueueStatus = z.infer<typeof BrowserQueueStatusSchema>;
export type QuarkDownloadFileResult = z.infer<typeof QuarkDownloadFileResultSchema>;
