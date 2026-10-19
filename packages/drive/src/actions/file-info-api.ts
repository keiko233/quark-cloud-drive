import type { Page } from "playwright";
import type { QuarkFileInfo } from "@quark/contract/schemas";
import {
  asObjectOrNull,
  buildQuarkApiUrl,
  QuarkApiError,
  readFiniteNumber,
  readString,
  requestQuarkApi,
} from "./renderer-http.ts";

/** Quark's drive root fid. */
export const ROOT_FID = "0";

const FILE_INFO_TIMEOUT_MS = 8_000;

type JsonObject = Record<string, unknown>;

/** One resolved entry from `GET /1/clouddrive/file/info`. */
export interface QuarkFileInfoEntry {
  fid: string;
  name: string;
  dir: boolean;
  parentFid: string;
  size?: number;
  fileType?: number;
  formatType?: string;
  updatedAt?: number;
  raw: JsonObject;
}

export function buildQuarkFileInfoUrl(fid: string): string {
  return buildQuarkApiUrl("/1/clouddrive/file/info", {
    fid,
    need_profile_tags: 1,
  });
}

/** Parse the `data` object of a file/info envelope. */
export function parseQuarkFileInfoData(data: unknown): QuarkFileInfoEntry {
  const entry = asObjectOrNull(data);
  const fid = readString(entry?.fid);
  const name = readString(entry?.file_name);
  const parentFid = typeof entry?.pdir_fid === "string"
    ? entry.pdir_fid
    : undefined;
  if (!entry || !fid || !name || parentFid === undefined) {
    throw new QuarkApiError("file/info returned an invalid entry");
  }

  return {
    fid,
    name,
    dir: entry.dir === true,
    parentFid,
    size: readFiniteNumber(entry.size),
    fileType: readFiniteNumber(entry.file_type),
    formatType: typeof entry.format_type === "string"
      ? entry.format_type
      : undefined,
    updatedAt: readFiniteNumber(entry.updated_at),
    raw: entry,
  };
}

export async function fetchQuarkFileInfoInBrowser(
  page: Page,
  fid: string,
): Promise<QuarkFileInfoEntry> {
  const envelope = await requestQuarkApi(page, {
    url: buildQuarkFileInfoUrl(fid),
    timeoutMs: FILE_INFO_TIMEOUT_MS,
  });
  return parseQuarkFileInfoData(envelope.data);
}

/** Project the API entry onto the normalized contract shape. */
export function mapQuarkFileInfo(
  entry: QuarkFileInfoEntry,
  includeRaw: boolean,
): QuarkFileInfo {
  return {
    fid: entry.fid,
    name: entry.name,
    dir: entry.dir,
    dirFid: entry.parentFid,
    sizeBytes: entry.size ?? null,
    fileType: entry.fileType ?? null,
    formatType: entry.formatType ?? null,
    updatedAtSeconds: entry.updatedAt ?? null,
    ...(includeRaw ? { raw: entry.raw } : {}),
  };
}
