import type { QuarkDownloadStartResult } from "@quark/contract/schemas";
import { log } from "../logger.ts";
import { getQuarkPage } from "./browser-session.ts";
import {
  resolveDownloadDirInBrowser,
  startQuarkDownloadInBrowser,
} from "./download-disk-api.ts";
import { fetchQuarkFileInfoInBrowser } from "./file-info-api.ts";

export interface StartDownloadInput {
  fid: string;
  /** Destination directory as the app sees it; defaults to app Downloads. */
  toDir?: string;
  raw?: boolean;
}

/**
 * Download one `fid` for real: resolve it through the drive API, then hand it
 * to the app's own downloader, which writes into the app's Downloads folder
 * (or `toDir`) and reports progress through GET /download-task.
 *
 * Unlike GET /download-file this has a disk side effect; unlike the UI it
 * never clicks a row, opens a menu or renders the transport panel.
 */
export async function startDownload(
  input: StartDownloadInput,
): Promise<QuarkDownloadStartResult> {
  const fid = input.fid.trim();
  if (fid === "") throw new Error("startDownload: fid is required");

  const page = await getQuarkPage();
  const info = await fetchQuarkFileInfoInBrowser(page, fid);
  const requested = input.toDir?.trim();
  const savePath = requested && requested !== ""
    ? requested
    : await resolveDownloadDirInBrowser(page);

  const started = await startQuarkDownloadInBrowser(page, {
    fid: info.fid,
    name: info.name,
    dirFid: info.parentFid,
    sizeBytes: info.size ?? null,
    dir: info.dir,
    savePath,
  });
  if (started.taskId === null) {
    throw new Error("startDownload: the app did not queue a download task");
  }

  log.debug(
    `startDownload: queued fid=${info.fid} dir=${info.dir} to ${savePath}`,
  );

  return {
    fid: info.fid,
    name: info.name,
    dir: info.dir,
    sizeBytes: info.size ?? null,
    directory: savePath,
    taskId: started.taskId,
    ...(input.raw === true
      ? { raw: { fileInfo: info.raw, task: started.raw } }
      : {}),
  };
}
