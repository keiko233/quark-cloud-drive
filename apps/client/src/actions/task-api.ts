import type { Page } from "playwright";
import type {
  QuarkTask,
  QuarkTaskCounts,
  QuarkTaskOperation,
  QuarkTaskStatus,
  QuarkTaskStatusFilter,
} from "@quark/contract/schemas";
import {
  QUARK_TASK_OPERATION_CODES,
  QUARK_TASK_STATUS_CODES,
  QUARK_TASK_TYPE_NAMES,
} from "@quark/contract/schemas";
import {
  asObjectOrNull,
  buildQuarkApiUrl,
  QuarkApiError,
  readFiniteNumber,
  readString,
  requestQuarkApi,
} from "./renderer-http.ts";

/**
 * Quark's cloud-task API (`/1/clouddrive/task/*`). This covers every task the
 * transport center shows: offline downloads, cloud saves, unzips, uploads and
 * browser downloads — read through the API, never through the transport DOM.
 */

const TASK_API_TIMEOUT_MS = 8_000;
const TASK_LIST_DEFAULT_SIZE = 20;
const TASK_LIST_MAX_SIZE = 100;

/** `/task/count` accepts a `task_type` list; without one Quark defaults to a subset. */
export const ALL_TASK_TYPE_CODES = Object.keys(QUARK_TASK_TYPE_NAMES).join(",");

type JsonObject = Record<string, unknown>;

const STATUS_NAMES: QuarkTaskStatus[] = [
  "todo",
  "running",
  "finish",
  "fail",
  "pause",
];

export interface QuarkTaskQuery {
  /** `all` (or omitted) lists every status. */
  status?: QuarkTaskStatusFilter;
  /** CSV of task-type names (`offline_download`) or numeric codes. */
  type?: string;
  size?: number;
  /** Opaque cursor returned by a previous page. */
  cursor?: string;
}

export interface QuarkTaskEntry {
  taskId: string;
  raw: JsonObject;
}

export interface QuarkTaskPage {
  tasks: QuarkTask[];
  entries: QuarkTaskEntry[];
  cursor: string | null;
  metadata: JsonObject;
}

export interface QuarkTaskCountsResult {
  counts: QuarkTaskCounts;
  raw: JsonObject;
}

/**
 * Encode the `{filter_end_task_id, filter_end_time}` pair Quark returns in
 * `metadata` into one opaque cursor. Quark ignores `_page` for
 * `/task/current/list`, so this pair is the only way to walk older tasks.
 */
export function encodeTaskCursor(endTaskId: string, endTime: number): string {
  return `${endTime}:${endTaskId}`;
}

export function decodeTaskCursor(
  cursor: string,
): { endTaskId: string; endTime: string } | null {
  const separator = cursor.indexOf(":");
  if (separator <= 0 || separator === cursor.length - 1) return null;
  const endTime = cursor.slice(0, separator);
  const endTaskId = cursor.slice(separator + 1);
  if (!/^\d+$/.test(endTime) || endTaskId.length === 0) return null;
  return { endTaskId, endTime };
}

export function clampTaskListSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size)) {
    return TASK_LIST_DEFAULT_SIZE;
  }
  return Math.max(1, Math.min(TASK_LIST_MAX_SIZE, Math.trunc(size)));
}

/** Translate a CSV of task-type names/codes into Quark's numeric `task_type`. */
export function toTaskTypeCsv(type: string): string {
  const codes = type.split(",").map((part) => part.trim()).filter(Boolean).map(
    (part) => {
      if (/^\d+$/.test(part)) return part;
      const code = Object.entries(QUARK_TASK_TYPE_NAMES)
        .find(([, name]) => name === part)?.[0];
      if (code === undefined) {
        throw new QuarkApiError(`unknown task type: ${part}`);
      }
      return code;
    },
  );
  if (codes.length === 0) throw new QuarkApiError("task type filter was empty");
  return codes.join(",");
}

function toTaskStatusCsv(filter: QuarkTaskStatusFilter | undefined): string {
  if (filter === undefined || filter === "all") return "";
  return String(QUARK_TASK_STATUS_CODES[filter]);
}

export function buildQuarkTaskListUrl(query: QuarkTaskQuery = {}): string {
  const params: Record<string, string | number | undefined> = {
    _size: clampTaskListSize(query.size),
  };
  if (query.type !== undefined) params.task_type = toTaskTypeCsv(query.type);

  const statusCsv = toTaskStatusCsv(query.status);
  if (statusCsv !== "") params.status = statusCsv;

  if (query.cursor !== undefined) {
    const decoded = decodeTaskCursor(query.cursor);
    if (!decoded) throw new QuarkApiError("invalid task cursor");
    params.filter_end_task_id = decoded.endTaskId;
    params.filter_end_time = decoded.endTime;
  }

  return buildQuarkApiUrl("/1/clouddrive/task/current/list", params);
}

export function buildQuarkTaskCountUrl(type?: string): string {
  return buildQuarkApiUrl("/1/clouddrive/task/count", {
    task_type: type !== undefined ? toTaskTypeCsv(type) : ALL_TASK_TYPE_CODES,
    status: STATUS_NAMES.map((name) => QUARK_TASK_STATUS_CODES[name]).join(","),
  });
}

export function buildQuarkTaskStatusUrl(): string {
  return buildQuarkApiUrl("/1/clouddrive/task/status");
}

export function taskStatusName(code: number): QuarkTaskStatus {
  const name = STATUS_NAMES.find((candidate) =>
    QUARK_TASK_STATUS_CODES[candidate] === code
  );
  if (name === undefined) {
    throw new QuarkApiError(`task status ${code} is not recognized`);
  }
  return name;
}

function nonNegativeInt(value: unknown): number | null {
  const number = readFiniteNumber(value);
  if (number === undefined || number < 0) return null;
  return Math.trunc(number);
}

/** Quark mixes second- and millisecond-precision timestamps across endpoints. */
function toEpochMs(value: unknown): number | null {
  const number = readFiniteNumber(value);
  if (number === undefined || number <= 0) return null;
  return number < 1e12 ? Math.round(number * 1000) : Math.trunc(number);
}

export function parseQuarkTaskEntry(value: unknown): QuarkTaskEntry {
  const entry = asObjectOrNull(value);
  const taskId = readString(entry?.task_id);
  if (!entry || taskId === undefined) {
    throw new QuarkApiError("task list returned an invalid entry");
  }
  return { taskId, raw: entry };
}

export function mapQuarkTask(entry: JsonObject): QuarkTask {
  const taskId = readString(entry.task_id);
  if (taskId === undefined) {
    throw new QuarkApiError("task entry had no task_id");
  }

  const statusCode = readFiniteNumber(entry.status);
  if (statusCode === undefined) {
    throw new QuarkApiError("task entry had no status");
  }

  const taskType = readFiniteNumber(entry.task_type) ?? -1;
  const size = readFiniteNumber(entry.size);
  const sizeBytes = size !== undefined && size >= 0 ? Math.trunc(size) : null;
  // `progress` is per-mille (a finished task reports 1000).
  const progressMilli = Math.max(
    0,
    Math.min(1000, Math.trunc(readFiniteNumber(entry.progress) ?? 0)),
  );

  return {
    taskId,
    taskType,
    taskTypeName: QUARK_TASK_TYPE_NAMES[taskType] ?? `taskType${taskType}`,
    status: taskStatusName(statusCode),
    title: readString(entry.task_title) ?? "",
    sizeBytes,
    transferredBytes: sizeBytes === null
      ? null
      : Math.round(sizeBytes * progressMilli / 1000),
    progressPercent: progressMilli / 10,
    fileNum: nonNegativeInt(entry.file_num),
    completedNum: nonNegativeInt(entry.completed_num),
    dirFid: readString(entry.dir_fid) ?? null,
    downloadType: readString(entry.download_type) ?? null,
    createdAt: toEpochMs(entry.created_at),
    updatedAt: toEpochMs(entry.updated_at),
  };
}

export function parseQuarkTaskCounts(data: unknown): QuarkTaskCounts {
  const root = asObjectOrNull(data);
  // `/task/count` answers `{count: {"2": 82}}`; accept a bare map too.
  const counts = asObjectOrNull(root?.count) ?? root;

  const read = (name: QuarkTaskStatus): number => {
    const value = readFiniteNumber(
      counts?.[String(QUARK_TASK_STATUS_CODES[name])],
    );
    return value === undefined || value < 0 ? 0 : Math.trunc(value);
  };

  const perStatus: Record<QuarkTaskStatus, number> = {
    todo: read("todo"),
    running: read("running"),
    finish: read("finish"),
    fail: read("fail"),
    pause: read("pause"),
  };
  const total = STATUS_NAMES.reduce((sum, name) => sum + perStatus[name], 0);
  return { ...perStatus, total };
}

/** Read the cursor pair Quark returns alongside a task page. */
export function readTaskCursor(metadata: JsonObject): string | null {
  const endTaskId = readString(metadata.filter_end_task_id);
  const endTime = readFiniteNumber(metadata.filter_end_time);
  if (endTaskId === undefined || endTime === undefined || endTime <= 0) {
    return null;
  }
  return encodeTaskCursor(endTaskId, endTime);
}

export async function fetchQuarkTaskPageInBrowser(
  page: Page,
  query: QuarkTaskQuery = {},
): Promise<QuarkTaskPage> {
  const size = clampTaskListSize(query.size);
  const envelope = await requestQuarkApi(page, {
    url: buildQuarkTaskListUrl(query),
    timeoutMs: TASK_API_TIMEOUT_MS,
  });

  const data = asObjectOrNull(envelope.data);
  if (!data || !Array.isArray(data.list)) {
    throw new QuarkApiError("task list returned invalid data");
  }

  const entries = data.list.map(parseQuarkTaskEntry);
  const cursor = readTaskCursor(envelope.metadata);
  return {
    tasks: entries.map((entry) => mapQuarkTask(entry.raw)),
    entries,
    // Only advertise a cursor when the page was full: Quark always echoes the
    // cursor pair, which would otherwise invite an endless empty walk.
    cursor: cursor !== null && entries.length >= size ? cursor : null,
    metadata: envelope.metadata,
  };
}

export async function fetchQuarkTaskCountsInBrowser(
  page: Page,
  type?: string,
): Promise<QuarkTaskCountsResult> {
  const envelope = await requestQuarkApi(page, {
    url: buildQuarkTaskCountUrl(type),
    timeoutMs: TASK_API_TIMEOUT_MS,
  });
  return {
    counts: parseQuarkTaskCounts(envelope.data),
    raw: asObjectOrNull(envelope.data) ?? {},
  };
}

export interface QuarkTaskMutationResult {
  raw: JsonObject;
}

export async function updateQuarkTasksInBrowser(
  page: Page,
  taskIds: string[],
  operation: QuarkTaskOperation,
): Promise<QuarkTaskMutationResult> {
  const envelope = await requestQuarkApi(page, {
    method: "POST",
    url: buildQuarkTaskStatusUrl(),
    body: {
      task_ids: taskIds,
      op_type: QUARK_TASK_OPERATION_CODES[operation],
    },
    timeoutMs: TASK_API_TIMEOUT_MS,
  });
  return { raw: asObjectOrNull(envelope.data) ?? {} };
}
