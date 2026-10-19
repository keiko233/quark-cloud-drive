import type { Page } from "playwright";
import type { QuarkFileListItem } from "@quark/contract/schemas";
import { ROOT_FID } from "./file-info-api.ts";
import {
  buildQuarkApiUrl,
  QuarkApiError,
  readFiniteNumber,
  requestQuarkApi,
} from "./renderer-http.ts";

export const FILE_LIST_API_PAGE_SIZE = 100;
const FILE_LIST_API_MAX_PAGES = 1_000;
const FILE_LIST_API_TIMEOUT_MS = 8_000;

type JsonObject = Record<string, unknown>;

export interface QuarkFileListApiItem {
  fid: string;
  file_name: string;
  dir: boolean;
  size?: number;
  file_type?: number;
  format_type?: string;
  updated_at?: number;
  raw: JsonObject;
}

export interface QuarkFileListApiPage {
  items: QuarkFileListApiItem[];
  page: number;
  size: number;
  count: number;
  total: number;
  rawMetadata: JsonObject;
}

export interface CollectQuarkFileListOptions {
  onProgress?: (seen: number, total: number) => void;
  onPage?: (page: QuarkFileListApiPage) => void;
  maxPages?: number;
  raw?: boolean;
}

export interface QuarkFileListApiResult {
  items: QuarkFileListItem[];
  fid: string;
  total: number;
  raw?: JsonObject;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function readPositiveNumber(value: unknown): number | undefined {
  const number = readFiniteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function parseItem(value: unknown): QuarkFileListApiItem {
  const item = asObject(value);
  if (
    !item ||
    typeof item.fid !== "string" ||
    typeof item.file_name !== "string" ||
    typeof item.dir !== "boolean"
  ) {
    throw new QuarkApiError("file/sort returned an invalid item");
  }

  return {
    fid: item.fid,
    file_name: item.file_name,
    dir: item.dir,
    size: readFiniteNumber(item.size),
    file_type: readFiniteNumber(item.file_type),
    format_type: typeof item.format_type === "string"
      ? item.format_type
      : undefined,
    updated_at: readFiniteNumber(item.updated_at),
    raw: item,
  };
}

function parsePagePayload(
  payload: unknown,
  requestedPage: number,
  requestedSize: number,
): QuarkFileListApiPage {
  const root = asObject(payload);
  if (!root) {
    throw new QuarkApiError("file/sort returned invalid JSON");
  }

  const code = readFiniteNumber(root.code) ?? Number(root.code);
  if (code !== 0) {
    throw new QuarkApiError(
      `file/sort returned code ${Number.isFinite(code) ? code : "unknown"}`,
    );
  }

  const data = asObject(root.data);
  if (!data || !Array.isArray(data.list)) {
    throw new QuarkApiError("file/sort returned invalid data");
  }

  const metadata = asObject(root.metadata);
  const items = data.list.map(parseItem);
  return {
    items,
    page: readPositiveNumber(metadata?._page) ?? requestedPage,
    size: readPositiveNumber(metadata?._size) ?? requestedSize,
    count: readFiniteNumber(metadata?._count) ?? items.length,
    total: readFiniteNumber(metadata?._total) ?? items.length,
    rawMetadata: metadata ?? {},
  };
}

export function buildQuarkFileListUrl(
  fid: string,
  page = 1,
  size = FILE_LIST_API_PAGE_SIZE,
): string {
  return buildQuarkApiUrl("/1/clouddrive/file/sort", {
    pdir_fid: fid,
    _page: String(page),
    _size: String(size),
    _fetch_total: "1",
    _fetch_sub_dirs: "0",
  });
}

export async function fetchQuarkFileListPageInBrowser(
  page: Page,
  fid: string,
  pageNumber = 1,
  pageSize = FILE_LIST_API_PAGE_SIZE,
): Promise<QuarkFileListApiPage> {
  const url = buildQuarkFileListUrl(fid, pageNumber, pageSize);
  const envelope = await requestQuarkApi(page, {
    url,
    timeoutMs: FILE_LIST_API_TIMEOUT_MS,
  });
  return parsePagePayload(
    { code: envelope.code, data: envelope.data, metadata: envelope.metadata },
    pageNumber,
    pageSize,
  );
}

export async function collectQuarkFileList(
  fetchPage: (pageNumber: number) => Promise<QuarkFileListApiPage>,
  options: CollectQuarkFileListOptions = {},
): Promise<QuarkFileListApiItem[]> {
  const seen = new Map<string, QuarkFileListApiItem>();
  const maxPages = Math.max(1, options.maxPages ?? FILE_LIST_API_MAX_PAGES);
  let total = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const page = await fetchPage(pageNumber);
    for (const item of page.items) seen.set(item.fid, item);
    total = page.total;
    options.onPage?.(page);
    options.onProgress?.(seen.size, total);

    if (page.items.length === 0) break;
    if (total > 0 && seen.size >= total) break;
    if (page.items.length < page.size) break;
    if (pageNumber === maxPages) {
      throw new QuarkApiError("file/sort pagination limit exceeded");
    }
  }

  if (total > 0 && seen.size < total) {
    throw new QuarkApiError("file/sort response was incomplete");
  }
  return [...seen.values()];
}

export function formatQuarkFileSize(
  size: number | undefined,
  isDirectory: boolean,
): string {
  if (isDirectory) return "-";
  if (size === undefined || !Number.isFinite(size) || size < 0) return "-";

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  const amount = unit === 0
    ? String(Math.round(value))
    : value.toFixed(1).replace(/\.0$/, "");
  return `${amount}${units[unit]}`;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function getDateFormatter(timeZone?: string): Intl.DateTimeFormat {
  const cacheKey = timeZone ?? "local";
  const cached = dateFormatters.get(cacheKey);
  if (cached) return cached;

  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      ...options,
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", options);
  }
  dateFormatters.set(cacheKey, formatter);
  return formatter;
}

export function formatQuarkUpdatedAt(
  timestamp: number | undefined,
  timeZone?: string,
): string {
  if (
    timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0
  ) {
    return "";
  }

  const milliseconds = timestamp < 1_000_000_000_000
    ? timestamp * 1000
    : timestamp;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return "";

  const parts = getDateFormatter(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}/${read("month")}/${read("day")} ${read("hour")}:${
    read("minute")
  }`;
}

function quarkFileType(item: QuarkFileListApiItem): string {
  if (item.dir) return "文件夹";

  const mime = (item.format_type ?? "").split(";")[0].trim().toLowerCase();
  if (
    /(android\.package|dosexec|msdownload|portable-executable)/.test(mime)
  ) {
    return "安装包";
  }
  if (
    /(zip|rar|gzip|tar|7z|bzip|xz|iso9660|compressed)/.test(mime)
  ) {
    return "压缩文件";
  }
  if (mime.startsWith("video/")) return "视频";
  if (mime.startsWith("image/")) return "图片";
  if (mime.startsWith("audio/")) return "音频";
  if (
    mime.startsWith("text/") ||
    /(pdf|word|sheet|presentation)/.test(mime)
  ) {
    return "文档";
  }

  const extension = item.file_name.split(".").pop()?.toLowerCase() ?? "";
  if (/(zip|rar|7z|tar|gz|bz2|xz|iso)$/.test(extension)) return "压缩文件";
  if (/(apk|exe|msi|dmg|pkg)$/.test(extension)) return "安装包";
  if (/(mp4|mkv|avi|mov|wmv|flv|webm|m2ts)$/.test(extension)) return "视频";
  if (/(jpg|jpeg|png|gif|webp|bmp|heic|svg)$/.test(extension)) return "图片";
  if (/(mp3|flac|wav|aac|m4a|ogg)$/.test(extension)) return "音频";
  if (/(pdf|docx?|xlsx?|pptx?|txt|md|csv)$/.test(extension)) return "文档";
  return "文件";
}

function normalizeApiText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function mapQuarkFileListItem(
  item: QuarkFileListApiItem,
  timeZone?: string,
): QuarkFileListItem {
  return {
    fid: item.fid,
    name: normalizeApiText(item.file_name),
    dir: item.dir,
    sizeBytes: item.size ?? null,
    size: formatQuarkFileSize(item.size, item.dir),
    type: quarkFileType(item),
    fileType: item.file_type ?? null,
    formatType: item.format_type ?? null,
    updatedAt: formatQuarkUpdatedAt(item.updated_at, timeZone),
    updatedAtSeconds: item.updated_at ?? null,
  };
}

let rendererTimeZone: string | undefined;
let rendererTimeZoneResolved = false;

async function getRendererTimeZone(page: Page): Promise<string | undefined> {
  if (rendererTimeZoneResolved) return rendererTimeZone;
  try {
    const value = await page.evaluate(() =>
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
    if (typeof value === "string" && value) {
      rendererTimeZone = value;
      rendererTimeZoneResolved = true;
    }
  } catch {
    // Retry on the next list call; the renderer may still be starting.
  }
  return rendererTimeZone;
}

/** Read a folder from Quark's JSON API by fid. Root is `fid=0`. */
export async function listQuarkFolderInBrowser(
  page: Page,
  fid: string = ROOT_FID,
  options: CollectQuarkFileListOptions = {},
): Promise<QuarkFileListApiResult> {
  const targetFid = fid.trim() || ROOT_FID;

  const pages: QuarkFileListApiPage[] = [];
  const items = await collectQuarkFileList(
    (pageNumber) =>
      fetchQuarkFileListPageInBrowser(page, targetFid, pageNumber),
    {
      ...options,
      onPage: (apiPage) => {
        pages.push(apiPage);
        options.onPage?.(apiPage);
      },
    },
  );
  const timeZone = await getRendererTimeZone(page);
  return {
    fid: targetFid,
    items: items.map((item) => mapQuarkFileListItem(item, timeZone)),
    total: items.length,
    ...(options.raw
      ? {
        raw: {
          fid: targetFid,
          items: items.map((item) => item.raw),
          pages: pages.map((apiPage) => apiPage.rawMetadata),
        },
      }
      : {}),
  };
}
