import type { Page } from "playwright";
import {
  asObjectOrNull,
  buildQuarkApiUrl,
  QuarkApiError,
  readFiniteNumber,
  readString,
  requestInRenderer,
  requestQuarkApi,
} from "./renderer-http.ts";

/**
 * Quark download resolution, API only.
 *
 * A file is a single `POST /1/clouddrive/file/download`, which returns a fresh
 * signed URL straight away. Quark has no folder archive: a folder is scanned
 * through `POST /1/clouddrive/download/list`, the scan task is polled on
 * `GET /1/clouddrive/task?fetch_partial_download_file=y`, and the resulting
 * manifest URLs list every file (id, name, relative path, size, md5). Each of
 * those files is then resolved to its own signed URL through `/file/download`
 * — exactly what Quark's own downloader does.
 *
 * Nothing here touches the transport UI, the file-list DOM, or the local
 * download manager.
 */

const DOWNLOAD_API_TIMEOUT_MS = 8_000;
const DOWNLOAD_POLL_INTERVAL_MS = 1_000;
const DOWNLOAD_POLL_TIMEOUT_MS = 60_000;
const DOWNLOAD_LIST_VERSION = "v3";

/** Quark's async task status codes, shared by every task kind. */
export const QUARK_TASK_STATUS_FINISH = 2;
export const QUARK_TASK_STATUS_FAIL = 3;

/** How many fids one `/file/download` batch carries. */
export const FILE_DOWNLOAD_BATCH_SIZE = 100;

/** Default cap on how many folder files get a resolved URL. */
export const DEFAULT_FOLDER_URL_LIMIT = 1_000;

type JsonObject = Record<string, unknown>;

export interface QuarkFileDownloadEntry {
  fid: string;
  name: string;
  dir: boolean;
  sizeBytes: number | null;
  md5: string | null;
  downloadUrl: string;
  raw: JsonObject;
}

/** One file from a folder manifest, before URL resolution. */
export interface QuarkFolderManifestEntry {
  fid: string;
  name: string;
  relativePath: string;
  dir: boolean;
  sizeBytes: number | null;
  md5: string | null;
  raw: JsonObject;
}

export interface QuarkFolderDownloadResult {
  taskId: string;
  status: number;
  entries: QuarkFolderManifestEntry[];
  raw: JsonObject;
}

export function buildQuarkFileDownloadUrl(): string {
  return buildQuarkApiUrl("/1/clouddrive/file/download");
}

export function buildQuarkDownloadListUrl(): string {
  return buildQuarkApiUrl("/1/clouddrive/download/list");
}

/** `/1/clouddrive/task` is also the folder-scan progress endpoint. */
export function buildQuarkTaskDetailUrl(
  taskId: string,
  options: { partialDownloadFile?: boolean } = {},
): string {
  return buildQuarkApiUrl("/1/clouddrive/task", {
    task_id: taskId,
    ...(options.partialDownloadFile === false
      ? {}
      : { fetch_partial_download_file: "y" }),
  });
}

function parseDownloadEntry(value: unknown): QuarkFileDownloadEntry {
  const entry = asObjectOrNull(value);
  const fid = readString(entry?.fid);
  const downloadUrl = readString(entry?.download_url);
  if (!entry || fid === undefined || downloadUrl === undefined) {
    throw new QuarkApiError("file/download returned an invalid entry");
  }

  const size = readFiniteNumber(entry.size);
  return {
    fid,
    name: readString(entry.file_name) ?? fid,
    dir: entry.dir === true,
    sizeBytes: size !== undefined && size >= 0 ? Math.trunc(size) : null,
    md5: readString(entry.md5) ?? null,
    downloadUrl,
    raw: entry,
  };
}

/** `POST /file/download` accepts a batch of fids and skips folders. */
export async function fetchQuarkFileDownloadsInBrowser(
  page: Page,
  fids: string[],
): Promise<QuarkFileDownloadEntry[]> {
  if (fids.length === 0) return [];
  const envelope = await requestQuarkApi(page, {
    method: "POST",
    url: buildQuarkFileDownloadUrl(),
    body: { fids, support_error_code: ["41060"] },
    timeoutMs: DOWNLOAD_API_TIMEOUT_MS,
  });

  if (!Array.isArray(envelope.data)) {
    throw new QuarkApiError("file/download returned invalid data");
  }
  return envelope.data.map(parseDownloadEntry);
}

export async function fetchQuarkFileDownloadInBrowser(
  page: Page,
  fid: string,
): Promise<QuarkFileDownloadEntry> {
  const entries = await fetchQuarkFileDownloadsInBrowser(page, [fid]);
  const entry = entries.find((candidate) => candidate.fid === fid) ??
    entries[0];
  if (!entry) {
    // Quark answers with an empty list for folders (and other non-file fids).
    throw new QuarkApiError("file/download returned no entry for the fid");
  }
  return entry;
}

function normalizeRelativePart(part: string): string {
  let value = part.replace(/\\/g, "/");
  while (value.startsWith("/")) value = value.slice(1);
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function joinRelativePath(dir: string, name: string): string {
  const parts = [dir, name]
    .map(normalizeRelativePart)
    .filter((part) => part !== "" && part !== ".");
  return parts.join("/");
}

function parseManifestEntry(value: unknown): QuarkFolderManifestEntry | null {
  const entry = asObjectOrNull(value);
  const fid = readString(entry?.fid);
  if (!entry || fid === undefined) return null;

  const name = readString(entry.file_name) ?? fid;
  const fileType = readFiniteNumber(entry.file_type);
  const dir = fileType === 0;
  const relativeDir = readString(entry.relative_path) ?? "";
  const relativePath = joinRelativePath(relativeDir, name);

  // Quark prepends a synthetic root marker (`/` + file_type 0) for folders.
  if (dir && (relativePath === "" || relativePath === "/")) return null;

  const size = readFiniteNumber(entry.size);
  return {
    fid,
    name,
    relativePath,
    dir,
    sizeBytes: size !== undefined && size >= 0 ? Math.trunc(size) : null,
    md5: readString(entry.md5) ?? null,
    raw: entry,
  };
}

/** Fetch one manifest chunk and keep only its file entries. */
async function fetchManifestEntriesInBrowser(
  page: Page,
  url: string,
): Promise<{ entries: QuarkFolderManifestEntry[]; raw: JsonObject }> {
  const response = await requestInRenderer(page, {
    url,
    timeoutMs: DOWNLOAD_API_TIMEOUT_MS,
  });
  if (response.status !== 200) {
    throw new QuarkApiError(
      `download manifest returned HTTP ${response.status}`,
      { status: response.status },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.text);
  } catch {
    throw new QuarkApiError("download manifest was not JSON");
  }

  const list = Array.isArray(payload)
    ? payload
    : Object.values(asObjectOrNull(payload) ?? {});
  if (!Array.isArray(list)) {
    throw new QuarkApiError("download manifest had no entry list");
  }

  const entries: QuarkFolderManifestEntry[] = [];
  for (const value of list) {
    const entry = parseManifestEntry(value);
    if (entry !== null) entries.push(entry);
  }
  return { entries, raw: { entries: list } };
}

/**
 * Ask Quark to scan a folder, then walk the manifest URLs it returns. Quark
 * has no folder archive: the "download" is this flat file list, which the
 * caller then downloads file by file.
 */
export async function requestQuarkFolderDownloadInBrowser(
  page: Page,
  fid: string,
): Promise<QuarkFolderDownloadResult> {
  const created = await requestQuarkApi(page, {
    method: "POST",
    url: buildQuarkDownloadListUrl(),
    body: { include_fids: [fid], version: DOWNLOAD_LIST_VERSION },
    timeoutMs: DOWNLOAD_API_TIMEOUT_MS,
  });

  const createdData = asObjectOrNull(created.data) ?? {};
  const taskId = readString(createdData.task_id) ?? "";
  const tqGap = readFiniteNumber(created.metadata.tq_gap);
  const interval = tqGap !== undefined && tqGap >= 200 && tqGap <= 5_000
    ? Math.trunc(tqGap)
    : DOWNLOAD_POLL_INTERVAL_MS;

  let payload = createdData;
  let status = readFiniteNumber(payload.status) ?? 0;
  let urlList = readUrlList(payload);

  const deadline = Date.now() + DOWNLOAD_POLL_TIMEOUT_MS;
  while (
    status !== QUARK_TASK_STATUS_FINISH && status !== QUARK_TASK_STATUS_FAIL &&
    taskId !== ""
  ) {
    if (urlList.length > 0) break;
    if (Date.now() >= deadline) {
      throw new QuarkApiError("folder scan did not finish in time");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    const polled = await requestQuarkApi(page, {
      url: buildQuarkTaskDetailUrl(taskId),
      timeoutMs: DOWNLOAD_API_TIMEOUT_MS,
    });
    payload = asObjectOrNull(polled.data) ?? payload;
    status = readFiniteNumber(payload.status) ?? status;
    urlList = readUrlList(payload);
  }

  if (status === QUARK_TASK_STATUS_FAIL) {
    throw new QuarkApiError("Quark failed to scan the folder");
  }
  if (taskId === "") {
    throw new QuarkApiError("folder scan returned no task id");
  }
  if (status !== QUARK_TASK_STATUS_FINISH) {
    throw new QuarkApiError("folder scan did not finish in time");
  }

  const entries: QuarkFolderManifestEntry[] = [];
  const manifestRaw: unknown[] = [];
  for (const url of urlList) {
    const manifest = await fetchManifestEntriesInBrowser(page, url);
    manifestRaw.push(manifest.raw);
    entries.push(...manifest.entries);
  }

  return {
    taskId,
    status,
    entries,
    raw: { task: payload, manifests: manifestRaw },
  };
}

function readUrlList(payload: JsonObject): string[] {
  const list = payload.download_url_list;
  if (!Array.isArray(list)) return [];
  return list.filter((url): url is string =>
    typeof url === "string" && url.length > 0
  );
}

/** Resolve signed URLs for up to `limit` files, in batches of 100. */
export async function resolveFolderDownloadUrlsInBrowser(
  page: Page,
  entries: QuarkFolderManifestEntry[],
  limit = DEFAULT_FOLDER_URL_LIMIT,
): Promise<Map<string, QuarkFileDownloadEntry>> {
  const fids = entries
    .filter((entry) => !entry.dir)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.fid);

  const resolved = new Map<string, QuarkFileDownloadEntry>();
  for (let index = 0; index < fids.length; index += FILE_DOWNLOAD_BATCH_SIZE) {
    const batch = fids.slice(index, index + FILE_DOWNLOAD_BATCH_SIZE);
    const downloaded = await fetchQuarkFileDownloadsInBrowser(page, batch);
    for (const entry of downloaded) resolved.set(entry.fid, entry);
  }
  return resolved;
}
