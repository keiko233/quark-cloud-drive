import type { QuarkFileList } from "@quark/contract/schemas";
import { log } from "@quark/config";
import { getQuarkPage } from "./browser-session.ts";
import { ROOT_FID } from "./file-info-api.ts";
import { listQuarkFolderInBrowser } from "./file-list-api.ts";

export interface ListFileInput {
  /** Folder id to list; `0` (the default) is the drive root. */
  fid?: string;
  raw?: boolean;
}

/**
 * List a folder straight from Quark's file API. There is no DOM navigation,
 * no virtual scrolling, no operation-queue entry, and no SSE stream: `fid` is
 * the only locator and every item carries its own `fid`.
 */
export async function listFile(
  input: ListFileInput = {},
): Promise<QuarkFileList> {
  const fid = input.fid?.trim() || ROOT_FID;
  const includeRaw = input.raw === true;

  const page = await getQuarkPage();
  const result = await listQuarkFolderInBrowser(page, fid, { raw: includeRaw });
  log.debug(`listFile: ${result.items.length} item(s) for fid=${result.fid}`);

  return {
    fid: result.fid,
    items: result.items,
    total: result.total,
    ...(includeRaw ? { raw: result.raw } : {}),
  };
}
