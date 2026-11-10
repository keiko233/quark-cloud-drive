import type { QuarkDownloadStartResult } from "@quark/contract/schemas";
import { QuarkApiError } from "../api/http.ts";
import { log } from "@quark/config";
import { getQuarkPage, getQuarkTransport } from "./quark-session.ts";
import {
  resolveDownloadDirInBrowser,
  startQuarkDownloadInBrowser,
} from "../browser/download-engine.ts";
import { fetchQuarkFileInfo } from "../api/file-info-api.ts";

export interface StartDownloadInput {
  fid: string;
  raw?: boolean;
}

/** Resolve file metadata then enqueue it in the app's native downloader. */
export async function startDownload(
  input: StartDownloadInput,
): Promise<QuarkDownloadStartResult> {
  const fid = input.fid.trim();
  if (fid === "") throw new Error("startDownload: fid is required");

  const page = await getQuarkPage();
  const info = await fetchQuarkFileInfo(getQuarkTransport(page), fid);
  const savePath = await resolveDownloadDirInBrowser(page);

  const started = await startQuarkDownloadInBrowser(page, {
    fid: info.fid,
    name: info.name,
    dirFid: info.parentFid,
    sizeBytes: info.size ?? null,
    dir: info.dir,
    savePath,
  });
  if (started.taskId === null) {
    throw new QuarkApiError("Quark did not return a local download task ID; check list_downloads before retrying");
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
      ? { raw: { getFile: info.raw, task: started.raw } }
      : {}),
  };
}
