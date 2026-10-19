import type { QuarkFileInfo } from "@quark/contract/schemas";
import { log } from "@quark/config";
import { getQuarkPage } from "./browser-session.ts";
import {
  fetchQuarkFileInfoInBrowser,
  mapQuarkFileInfo,
} from "./file-info-api.ts";

export interface FileInfoInput {
  /** Quark id of the file or folder. */
  fid: string;
  raw?: boolean;
}

/** Read one entry's metadata from `GET /1/clouddrive/file/info`. */
export async function fileInfo(input: FileInfoInput): Promise<QuarkFileInfo> {
  const fid = input.fid.trim();
  if (fid === "") throw new Error("fileInfo: fid is required");

  const page = await getQuarkPage();
  const entry = await fetchQuarkFileInfoInBrowser(page, fid);
  log.debug(`fileInfo: resolved fid=${entry.fid}`);
  return mapQuarkFileInfo(entry, input.raw === true);
}
