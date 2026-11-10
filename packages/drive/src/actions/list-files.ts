import type { QuarkFileList } from "@quark/contract/schemas";
import { log } from "@quark/config";
import { getQuarkTransport } from "./quark-session.ts";
import { ROOT_FID } from "../api/file-info-api.ts";
import { listQuarkFolder } from "../api/file-list-api.ts";

export interface ListFilesInput {
  /** Folder id to list; `0` (the default) is the drive root. */
  fid?: string;
  raw?: boolean;
}

/**
 * List a folder straight from Quark's file API. There is no DOM navigation,
 * no virtual scrolling, no operation-queue entry, and no SSE stream: `fid` is
 * the only locator and every item carries its own `fid`.
 */
export async function listFiles(
  input: ListFilesInput = {},
): Promise<QuarkFileList> {
  const fid = input.fid?.trim() || ROOT_FID;
  const includeRaw = input.raw === true;

  const transport = getQuarkTransport();
  const result = await listQuarkFolder(transport, fid, { raw: includeRaw });
  log.debug(`listFiles: ${result.items.length} item(s) for fid=${result.fid}`);

  return {
    fid: result.fid,
    items: result.items,
    total: result.total,
    ...(includeRaw ? { raw: result.raw } : {}),
  };
}
