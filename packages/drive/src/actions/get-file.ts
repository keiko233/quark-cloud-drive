import type { QuarkFileInfo } from "@quark/contract/schemas";
import { log } from "@quark/config";
import { getQuarkTransport } from "./quark-session.ts";
import {
  fetchQuarkFileInfo,
  mapQuarkFileInfo,
} from "../api/file-info-api.ts";

export interface GetFileInput {
  /** Quark id of the file or folder. */
  fid: string;
  raw?: boolean;
}

/** Read one entry's metadata from `GET /1/clouddrive/file/info`. */
export async function getFile(input: GetFileInput): Promise<QuarkFileInfo> {
  const fid = input.fid.trim();
  if (fid === "") throw new Error("getFile: fid is required");

  const transport = getQuarkTransport();
  const entry = await fetchQuarkFileInfo(transport, fid);
  log.debug(`getFile: resolved fid=${entry.fid}`);
  return mapQuarkFileInfo(entry, input.raw === true);
}
