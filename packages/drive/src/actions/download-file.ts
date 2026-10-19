import type {
  QuarkDownloadEntry,
  QuarkDownloadFileResult,
} from "@quark/contract/schemas";
import { log } from "@quark/config";
import { getQuarkPage } from "./browser-session.ts";
import {
  DEFAULT_FOLDER_URL_LIMIT,
  fetchQuarkFileDownloadInBrowser,
  requestQuarkFolderDownloadInBrowser,
  resolveFolderDownloadUrlsInBrowser,
} from "./download-api.ts";
import { fetchQuarkFileInfoInBrowser } from "./file-info-api.ts";

export interface DownloadFileOptions {
  /** Max folder file URLs to resolve; extra files come back without a URL. */
  limit?: number;
  raw?: boolean;
}

/**
 * Resolve signed download URLs for one `fid`, purely through Quark's API.
 *
 * A file is one `/file/download` call. A folder is scanned through
 * `/download/list`, its manifest is walked, and each file inside is resolved
 * through `/file/download` — the same sequence Quark's own downloader uses.
 * No row is selected, no toolbar button is clicked, and the transport tab is
 * never opened.
 *
 * Every returned URL is short-lived and signed: treat it as a secret.
 */
export async function downloadFile(
  fid: string,
  options: DownloadFileOptions = {},
): Promise<QuarkDownloadFileResult> {
  const targetFid = fid.trim();
  if (targetFid === "") throw new Error("downloadFile: fid is required");
  const includeRaw = options.raw === true;
  const limit = options.limit ?? DEFAULT_FOLDER_URL_LIMIT;

  const page = await getQuarkPage();
  const info = await fetchQuarkFileInfoInBrowser(page, targetFid);

  if (!info.dir) {
    const entry = await fetchQuarkFileDownloadInBrowser(page, targetFid);
    log.debug(`downloadFile: file URL ready for fid=${entry.fid}`);
    const resolved: QuarkDownloadEntry = {
      fid: entry.fid,
      name: entry.name,
      relativePath: "",
      dir: false,
      sizeBytes: entry.sizeBytes,
      md5: entry.md5,
      downloadUrl: entry.downloadUrl,
    };
    return {
      fid: entry.fid,
      name: entry.name,
      dir: false,
      sizeBytes: entry.sizeBytes,
      md5: entry.md5,
      downloadUrl: entry.downloadUrl,
      taskId: null,
      total: 1,
      urlsResolved: 1,
      truncated: false,
      entries: [resolved],
      ...(includeRaw
        ? { raw: { fileInfo: info.raw, download: entry.raw } }
        : {}),
    };
  }

  const scan = await requestQuarkFolderDownloadInBrowser(page, targetFid);
  const urls = await resolveFolderDownloadUrlsInBrowser(
    page,
    scan.entries,
    limit,
  );
  const entries: QuarkDownloadEntry[] = scan.entries.map((entry) => {
    const download = urls.get(entry.fid);
    return {
      fid: entry.fid,
      name: entry.name,
      relativePath: entry.relativePath,
      dir: entry.dir,
      sizeBytes: download?.sizeBytes ?? entry.sizeBytes,
      md5: download?.md5 ?? entry.md5,
      downloadUrl: download?.downloadUrl ?? null,
    };
  });
  const files = entries.filter((entry) => !entry.dir);
  const urlsResolved =
    files.filter((entry) => entry.downloadUrl !== null).length;

  log.debug(
    `downloadFile: folder scan found ${files.length} file(s), ` +
      `${urlsResolved} URL(s) resolved`,
  );

  return {
    fid: targetFid,
    name: info.name,
    dir: true,
    sizeBytes: files.reduce(
      (sum, entry) => sum + (entry.sizeBytes ?? 0),
      0,
    ),
    md5: null,
    downloadUrl: null,
    taskId: scan.taskId,
    total: files.length,
    urlsResolved,
    truncated: urlsResolved < files.length,
    entries,
    ...(includeRaw
      ? { raw: { fileInfo: info.raw, downloadList: scan.raw } }
      : {}),
  };
}
