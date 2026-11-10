import { z } from "zod";

// ─── Process state (@quark/manager) ─────────────────────────────────────────────

export const ProcessStateSchema = z.enum([
  "stopped",
  "starting",
  "running_visible",
  "running_minimized",
]).describe(
  "Process state of Quark as tracked by @quark/manager: `stopped`, `starting`, " +
    "`running_visible`, or `running_minimized`.",
);

export const ProcessCountsSchema = z.object({
  start: z.number().int().nonnegative(),
  stop: z.number().int().nonnegative(),
  minimize: z.number().int().nonnegative(),
}).describe("Cumulative lifecycle operation counters.");

export const ServerStatusSchema = z.object({
  state: ProcessStateSchema,
  pid: z.number().int().nullable().describe(
    "PID of the tracked launcher process, or null when stopped.",
  ),
  alive: z.boolean().describe(
    "Whether Quark is actually serving CDP (TCP probe on the CDP port), " +
      "regardless of the tracked launcher PID.",
  ),
  startedAt: z.number().nullable().describe(
    "Epoch ms of the last start, or null when stopped.",
  ),
  cdpActivityAt: z.number().nullable().describe(
    "Epoch ms of the last drive request or diagnostic CDP activity, or null. " +
      "Exposed so @quark/service can make idle decisions without polling CDP itself.",
  ),
  counts: ProcessCountsSchema,
});

// ─── Server events (SSE from @quark/manager) ────────────────────────────────────

export const ServerEventSchema = z.union([
  z.object({
    type: z.literal("process"),
    state: ProcessStateSchema,
    at: z.number().describe("Epoch ms of the transition."),
  }),
  z.object({
    type: z.literal("activity"),
    at: z.number().describe("Epoch ms of the CDP activity."),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

// ─── Quark business API primitives ───────────────────────────────────────────
//
// Files, account, shares and cloud tasks call Quark JSON APIs. Local
// transfers use the Quark client's native download engine.

export const RawOptionSchema = z.union([
  z.boolean(),
  z.enum(["true", "false", "1", "0"]).transform((value) =>
    value === "true" || value === "1"
  ),
]).optional().describe(
  "When true, include the untouched upstream payload in the response's " +
    "`raw` object. Query strings accept `true`/`false`/`1`/`0`; JSON bodies " +
    "may use booleans. Raw data may be large and may change without notice.",
);

export const RawObjectSchema = z.record(z.string(), z.unknown()).describe(
  "Untouched Quark API fields for this call, nested under `raw` so the " +
    "normalized fields stay stable when Quark changes its payload.",
);

// ─── File listing ────────────────────────────────────────────────────────────

export const QuarkFileListItemSchema = z.object({
  fid: z.string().describe(
    "Quark file/folder id. This is the only locator the API needs.",
  ),
  name: z.string().describe(
    "File or folder name exactly as Quark stores it.",
  ),
  dir: z.boolean().describe(
    "True for folders, false for files. Use this instead of parsing `type`.",
  ),
  sizeBytes: z.number().int().nonnegative().nullable().describe(
    "Exact file size in bytes; `0` for folders.",
  ),
  size: z.string().describe(
    "Human-readable size text (e.g. `12.3MB`, `1.2GB`, or `-` for folders).",
  ),
  type: z.string().describe(
    "Normalized file-type label derived from `formatType`/extension " +
      "(e.g. `视频`, `文档`, `文件夹`).",
  ),
  fileType: z.number().int().nullable().describe(
    "Quark's numeric file type (`0` folder, `1` file).",
  ),
  formatType: z.string().nullable().describe(
    "MIME/format string supplied by the API, when available.",
  ),
  updatedAt: z.string().describe(
    "Formatted last-modified time in the renderer time zone " +
      "(e.g. `2026/06/07 12:34`).",
  ),
  updatedAtSeconds: z.number().int().nonnegative().nullable().describe(
    "Original Unix timestamp in milliseconds as returned by the API.",
  ),
});

export const QuarkFileListSchema = z.object({
  fid: z.string().describe(
    "Folder id that was listed. `0` is the drive root.",
  ),
  items: z.array(QuarkFileListItemSchema).describe(
    "Files and folders directly under `fid`, in the order Quark returns " +
      "them.",
  ),
  total: z.number().int().nonnegative().describe(
    "Number of items returned in `items`.",
  ),
  raw: RawObjectSchema.optional(),
});

// ─── File info ───────────────────────────────────────────────────────────────

export const QuarkFileInfoSchema = z.object({
  fid: z.string().describe("Quark id of the file or folder."),
  name: z.string().describe("Stored file/folder name."),
  dir: z.boolean().describe("True for folders, false for files."),
  dirFid: z.string().describe(
    "Quark id of the parent folder. `0` means the drive root.",
  ),
  sizeBytes: z.number().int().nonnegative().nullable().describe(
    "Exact size in bytes; `0` for folders.",
  ),
  fileType: z.number().int().nullable().describe(
    "Quark's numeric file type (`0` folder, `1` file).",
  ),
  formatType: z.string().nullable().describe(
    "MIME/format string supplied by the API, when available.",
  ),
  updatedAtSeconds: z.number().int().nonnegative().nullable().describe(
    "Last-modified time as returned by the API (Unix milliseconds).",
  ),
  raw: RawObjectSchema.optional(),
});

// ─── Cloud tasks (transport center) ──────────────────────────────────────────

/** Numeric `status` codes used by `/1/clouddrive/task/*`. */
export const QUARK_TASK_STATUS_CODES = {
  todo: 0,
  running: 1,
  finish: 2,
  fail: 3,
  pause: 4,
} as const;

/**
 * Numeric `op_type` codes for `POST /1/clouddrive/task/status`. `resume` also
 * retries a failed task; there is no cloud-API pause code.
 */
export const QUARK_TASK_OPERATION_CODES = {
  delete: 0,
  resume: 1,
} as const;

/** Numeric `task_type` codes used by Quark's cloud task list. */
export const QUARK_TASK_TYPE_NAMES: Record<number, string> = {
  0: "upload",
  1: "download",
  2: "offline",
  3: "backup",
  4: "unzip",
  5: "offline_download",
  6: "cloud_save",
  7: "speedup_download",
  8: "browser_download",
  9: "abnormal_download",
  10: "device_upload",
};

export const QuarkTaskStatusSchema = z.enum([
  "todo",
  "running",
  "finish",
  "fail",
  "pause",
]).describe(
  "Cloud task lifecycle state decoded from Quark's numeric `status`.",
);

export const QuarkTaskStatusFilterSchema = z.enum([
  "all",
  "todo",
  "running",
  "finish",
  "fail",
  "pause",
]).describe(
  "Status filter for `GET /cloud-tasks`. `all` omits the filter entirely.",
);

export const QuarkTaskOperationSchema = z.enum(["resume", "delete"])
  .describe(
    "Operation applied to the given task ids. Quark's cloud API supports " +
      "`resume` (`op_type=1`, also retries) and `delete` (`op_type=0`).",
  );

export const QuarkTaskSchema = z.object({
  taskId: z.string().describe("Quark task id; pass it to PATCH /cloud-tasks."),
  taskType: z.number().int().describe(
    "Quark's numeric task type (see `taskTypeName`).",
  ),
  taskTypeName: z.string().describe(
    "Decoded task type, e.g. `offline_download`, `cloud_save`, `unzip`.",
  ),
  status: QuarkTaskStatusSchema,
  title: z.string().describe(
    "Task title as Quark stores it — usually the file or folder name.",
  ),
  sizeBytes: z.number().int().nonnegative().nullable().describe(
    "Total task size in bytes when reported.",
  ),
  transferredBytes: z.number().int().nonnegative().nullable().describe(
    "Bytes transferred so far, derived from `size` and `progress`.",
  ),
  progressPercent: z.number().min(0).max(100).describe(
    "Completion percentage (Quark reports per-mille; this is 0-100).",
  ),
  fileNum: z.number().int().nonnegative().nullable().describe(
    "Number of files in the task when reported.",
  ),
  completedNum: z.number().int().nonnegative().nullable().describe(
    "Number of files already processed when reported.",
  ),
  dirFid: z.string().nullable().describe(
    "Destination folder id when the task saves into the drive.",
  ),
  downloadType: z.string().nullable().describe(
    "Quark's `download_type` label (e.g. `MAGNET`) for offline downloads.",
  ),
  createdAt: z.number().int().nonnegative().nullable().describe(
    "Creation time in epoch milliseconds.",
  ),
  updatedAt: z.number().int().nonnegative().nullable().describe(
    "Last update time in epoch milliseconds.",
  ),
});

export const QuarkTaskCountsSchema = z.object({
  todo: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  finish: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  pause: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).describe("Cloud task counts per status for the requested task types.");

export const QuarkTaskListSchema = z.object({
  tasks: z.array(QuarkTaskSchema).describe(
    "Matching cloud tasks, newest first as Quark returns them.",
  ),
  counts: QuarkTaskCountsSchema.describe(
    "Counts across the requested task types, independent of `size`.",
  ),
  cursor: z.string().nullable().describe(
    "Pass back as `cursor` to fetch the next page; null when Quark " +
      "reports no older tasks.",
  ),
  raw: RawObjectSchema.optional(),
});

export const QuarkUpdateTaskResultSchema = z.object({
  success: z.boolean().describe(
    "True when Quark accepted the operation for the given task ids.",
  ),
  taskIds: z.array(z.string()).describe("Task ids the operation applied to."),
  operation: QuarkTaskOperationSchema,
  raw: RawObjectSchema.optional(),
});

// ─── Local downloads (the app's own downloader) ──────────────────────────────
//

/**
 * Numeric `status` codes on the app's download-task objects. There is no
 * cloud counterpart for these; they describe the local transfer engine.
 */
export const QUARK_LOCAL_DOWNLOAD_STATUS_CODES = {
  error: -1,
  new: 0,
  init: 1,
  ready: 2,
  running: 3,
  pause: 4,
  cancel: 5,
  finish: 6,
} as const;

export const QuarkDownloadStatusSchema = z.enum([
  "error",
  "new",
  "init",
  "ready",
  "running",
  "pause",
  "cancel",
  "finish",
  "unknown",
]).describe(
  "Local download state decoded from the app's numeric status: -1 error," +
    " 0 new, 1 init, 2 ready, 3 running, 4 pause, 5 cancel, 6 finish.",
);

export const QuarkDownloadTaskSchema = z.object({
  taskId: z.string().describe(
    "Local task id; pass it to PATCH /downloads to pause, resume or cancel.",
  ),
  name: z.string().describe("File or folder name being downloaded."),
  status: QuarkDownloadStatusSchema,
  statusCode: z.number().int().describe(
    "Raw numeric status (see `QUARK_LOCAL_DOWNLOAD_STATUS_CODES`).",
  ),
  progressPercent: z.number().min(0).max(100).describe(
    "Completion percentage as the app reports it (100 on finish).",
  ),
  sizeBytes: z.number().int().nonnegative().nullable().describe(
    "Total transfer size in bytes, or null before the app knows it.",
  ),
  transferredBytes: z.number().int().nonnegative().nullable().describe(
    "Bytes the local engine has moved so far.",
  ),
  speedBytesPerSec: z.number().nonnegative().describe(
    "Display speed in bytes per second.",
  ),
  path: z.string().nullable().describe(
    "Absolute path of the destination as the app sees it, including the " +
      "entry name (e.g. `C:\\users\\wineuser\\Downloads\\report.pdf`), or " +
      "null when the app has not reported one yet.",
  ),
  error: z.string().nullable().describe(
    "Failure detail when the app reported one.",
  ),
  createdAt: z.number().nullable().describe("Epoch ms when the task appeared."),
  updatedAt: z.number().nullable().describe("Epoch ms of the last update."),
  finishedAt: z.number().nullable().describe(
    "Epoch ms when the transfer finished or failed.",
  ),
});

export const QuarkDownloadStartResultSchema = z.object({
  fid: z.string().describe("Quark id handed to the local downloader."),
  name: z.string().describe("Stored file/folder name."),
  dir: z.boolean().describe(
    "True when a whole folder was queued; the app then writes every " +
      "descendant below Downloads.",
  ),
  sizeBytes: z.number().int().nonnegative().nullable().describe(
    "Size as reported by the drive API (null when unknown).",
  ),
  directory: z.string().describe(
    "The app's Downloads directory. Query GET /downloads with the taskId for the final path.",
  ),
  taskId: z.string().describe(
    "Id of the created local task; read it back with GET /downloads.",
  ),
  raw: RawObjectSchema.optional(),
});

export const QuarkDownloadQueueSchema = z.object({
  tasks: z.array(QuarkDownloadTaskSchema).describe(
    "Local transfers the app is still running or has already finished.",
  ),
  counts: z.object({
    total: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    finished: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).describe("Task tallies over `tasks`."),
  raw: RawObjectSchema.optional(),
});

export const QuarkDownloadOperationSchema = z.enum([
  "pause",
  "resume",
  "cancel",
]).describe(
  "`pause`/`resume` control the transfer engine; `cancel` stops the task, " +
    "removes it from the app's list. Partial cleanup is best effort.",
);

export const QuarkDownloadControlResultSchema = z.object({
  success: z.boolean(),
  taskIds: z.array(z.string()),
  operation: QuarkDownloadOperationSchema,
  removedPartials: z.array(z.string()).describe(
    "Absolute paths of `.qkdownloading` partial files deleted by `cancel`.",
  ),
  raw: RawObjectSchema.optional(),
});

// ─── Share import ────────────────────────────────────────────────────────────

export const QuarkShareUrlSchema = z.string().trim().regex(
  /^(?:[A-Za-z0-9_-]+|https:\/\/pan\.quark\.cn\/s\/[A-Za-z0-9_-]+\/?(?:[?#][^\s]*)?)$/,
  "Use a https://pan.quark.cn/s/<id> URL or a bare share ID",
);

export const QuarkShareSubmissionSchema = z.object({
  taskId: z.string().min(1),
  toDirFid: z.string(),
  status: z.literal("submitted"),
});

export const QuarkShareImportSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["pending", "completed", "failed", "paused"]),
  savedFids: z.array(z.string()).describe("IDs reported by Quark; may be empty."),
  nextRetryIndex: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});

// ─── Account / login ─────────────────────────────────────────────────────────

export const QuarkLoginStatusSchema = z.object({
  loggedIn: z.boolean().describe(
    "True when the renderer session is authenticated against Quark's API.",
  ),
  raw: RawObjectSchema.optional(),
});

export const QuarkUserInfoSchema = z.object({
  capacity: z.string().describe(
    "Quark's compact capacity string, for example `4.3T/6T`.",
  ),
  useCapacity: z.number().int().nonnegative().nullable().describe(
    "Used capacity in bytes.",
  ),
  totalCapacity: z.number().int().nonnegative().nullable().describe(
    "Total capacity in bytes.",
  ),
  raw: RawObjectSchema.optional(),
});

// ─── Operation queue (our internal serialization) ────────────────────────────

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

// ─── Runtime configuration/status (@quark/service backend) ────────────────────

export const RuntimeConfigSchema = z.object({
  enabled: z.boolean().describe("Whether the idle monitor is enabled."),
  checkIntervalMs: z.number().int().min(1_000).max(3_600_000),
  taskProbeIntervalMs: z.number().int().min(5_000).max(3_600_000),
  activityWindowMs: z.number().int().min(1_000).max(3_600_000),
  minimizeAfterMs: z.number().int().nonnegative().max(86_400_000),
  stopAfterMs: z.number().int().nonnegative().max(7 * 86_400_000),
  stopWhenLoggedOut: z.boolean(),
  stopWhenUnhealthy: z.boolean(),
});

export const RuntimeConfigPatchSchema = RuntimeConfigSchema.partial();

export const LoginStateSchema = z.enum(["logged_in", "logged_out", "unknown"]);

export const RuntimeHealthSchema = z.enum(["healthy", "degraded", "unhealthy"]);

export const RuntimeStatusSchema = z.object({
  generatedAt: z.number().int().nonnegative(),
  process: ServerStatusSchema,
  login: LoginStateSchema,
  tasks: z.object({
    running: z.number().int().nonnegative().nullable().describe(
      "Active cloud-task count (todo + running) from Quark's task API, or " +
        "null when it has not been probed yet.",
    ),
    checkedAt: z.number().int().nonnegative().nullable(),
  }),
  queue: BrowserQueueStatusSchema,
  health: RuntimeHealthSchema,
  healthScore: z.number().int().min(0).max(100),
  idleForMs: z.number().int().nonnegative(),
  monitor: z.object({
    enabled: z.boolean(),
    checkIntervalMs: z.number().int().positive(),
    lastCheckAt: z.number().int().nonnegative().nullable(),
    nextCheckAt: z.number().int().nonnegative().nullable(),
    lastDecision: z.string().nullable(),
    lastReason: z.string().nullable(),
  }),
  guard: z.object({
    blocked: z.boolean(),
    reason: z.string().nullable(),
  }),
  lastError: z.string().nullable(),
});
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type RuntimeConfigPatch = z.infer<typeof RuntimeConfigPatchSchema>;
export type LoginState = z.infer<typeof LoginStateSchema>;
export type RuntimeHealth = z.infer<typeof RuntimeHealthSchema>;

// ─── Client events (global SSE from @quark/service) ─────────────────────────────

export const ClientEventSchema = z.union([
  z.object({
    type: z.literal("queue"),
    status: BrowserQueueStatusSchema,
  }),
  z.object({
    type: z.literal("process"),
    state: ProcessStateSchema,
    source: z.literal("server").describe(
      "These events mirror @quark/manager process transitions.",
    ),
  }),
  z.object({
    type: z.literal("monitor"),
    decision: z.enum(["minimize", "stop", "restore"]),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("operation"),
    key: z.string(),
    phase: z.enum(["started", "done", "error"]),
  }),
  z.object({
    type: z.literal("status"),
    status: RuntimeStatusSchema,
  }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

// ─── Derived types ───────────────────────────────────────────────────────────

export type QuarkFileListItem = z.infer<typeof QuarkFileListItemSchema>;
export type QuarkFileList = z.infer<typeof QuarkFileListSchema>;
export type QuarkFileInfo = z.infer<typeof QuarkFileInfoSchema>;
export type QuarkLoginStatus = z.infer<typeof QuarkLoginStatusSchema>;
export type QuarkUserInfo = z.infer<typeof QuarkUserInfoSchema>;
export type QuarkTask = z.infer<typeof QuarkTaskSchema>;
export type QuarkTaskList = z.infer<typeof QuarkTaskListSchema>;
export type QuarkTaskStatus = z.infer<typeof QuarkTaskStatusSchema>;
export type QuarkTaskStatusFilter = z.infer<typeof QuarkTaskStatusFilterSchema>;
export type QuarkTaskOperation = z.infer<typeof QuarkTaskOperationSchema>;
export type QuarkTaskCounts = z.infer<typeof QuarkTaskCountsSchema>;
export type BrowserQueueStatus = z.infer<typeof BrowserQueueStatusSchema>;
export type QuarkDownloadStatus = z.infer<typeof QuarkDownloadStatusSchema>;
export type QuarkDownloadTask = z.infer<typeof QuarkDownloadTaskSchema>;
export type QuarkDownloadStartResult = z.infer<
  typeof QuarkDownloadStartResultSchema
>;
export type QuarkDownloadQueue = z.infer<typeof QuarkDownloadQueueSchema>;
export type QuarkDownloadOperation = z.infer<
  typeof QuarkDownloadOperationSchema
>;
export type QuarkDownloadControlResult = z.infer<
  typeof QuarkDownloadControlResultSchema
>;
export type QuarkShareSubmission = z.infer<typeof QuarkShareSubmissionSchema>;
export type QuarkShareImport = z.infer<typeof QuarkShareImportSchema>;
export type QuarkUpdateTaskResult = z.infer<
  typeof QuarkUpdateTaskResultSchema
>;
export type ProcessState = z.infer<typeof ProcessStateSchema>;
export type ProcessCounts = z.infer<typeof ProcessCountsSchema>;
export type ServerStatus = z.infer<typeof ServerStatusSchema>;
