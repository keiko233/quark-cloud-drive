import type { QuarkImportShareLinkResult } from "@quark/contract/schemas";
import { log } from "@quark/config";
import { userInfoCache } from "../cache/caches.ts";
import { getQuarkPage } from "./browser-session.ts";
import { listQuarkFolderInBrowser } from "./file-list-api.ts";
import { QuarkApiError } from "./renderer-http.ts";
import {
  fetchQuarkShareDetailInBrowser,
  fetchQuarkShareSaveDirInBrowser,
  fetchQuarkShareTokenInBrowser,
  parseQuarkShareUrl,
  pollQuarkTaskInBrowser,
  QUARK_TASK_STATUS_FAIL,
  QUARK_TASK_STATUS_FINISH,
  readQuarkTaskSavedFids,
  saveQuarkShareInBrowser,
} from "./share-api.ts";

export interface ImportShareLinkOptions {
  /** Overrides a passcode embedded in the URL (`?pwd=...`). */
  passcode?: string;
  /** Destination folder id; defaults to Quark's `来自：分享`. */
  toFid?: string;
  raw?: boolean;
}

/**
 * Fallback mapping of the saved share entries to the fids Quark created, used
 * only when the save task did not report them: the destination is listed once
 * and matched by name. Prefer `readQuarkTaskSavedFids`, which is exact.
 */
async function matchSavedFids(
  page: Awaited<ReturnType<typeof getQuarkPage>>,
  toFid: string,
  names: string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  try {
    const listing = await listQuarkFolderInBrowser(page, toFid);
    const wanted = new Set(names);
    const fids: string[] = [];
    for (const item of listing.items) {
      if (wanted.has(item.name) && !fids.includes(item.fid)) {
        fids.push(item.fid);
      }
    }
    return fids;
  } catch (error) {
    log.warn(
      `importShareLink: could not map saved fids (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return [];
  }
}

/**
 * Save a `https://pan.quark.cn/s/...` share into the drive using Quark's share
 * API: token -> detail -> save -> task poll. The share page is never opened.
 */
export async function importShareLink(
  url: string,
  options: ImportShareLinkOptions = {},
): Promise<QuarkImportShareLinkResult> {
  const identity = parseQuarkShareUrl(url);
  const passcode = options.passcode?.trim() || identity.passcode || "";
  const includeRaw = options.raw === true;

  const page = await getQuarkPage();
  const token = await fetchQuarkShareTokenInBrowser(page, {
    pwdId: identity.pwdId,
    passcode: passcode === "" ? null : passcode,
  });

  const detail = await fetchQuarkShareDetailInBrowser(
    page,
    identity.pwdId,
    token.stoken,
  );
  if (detail.entries.length === 0) {
    throw new QuarkApiError("share contained no entries to save");
  }

  const toDirFid = options.toFid?.trim() ||
    (await fetchQuarkShareSaveDirInBrowser(page)).fid;

  const save = await saveQuarkShareInBrowser(page, {
    pwdId: identity.pwdId,
    stoken: token.stoken,
    toDirFid,
    entries: detail.entries,
  });

  const task = save.taskId === ""
    ? null
    : await pollQuarkTaskInBrowser(page, save.taskId);
  if (task !== null && task.status === QUARK_TASK_STATUS_FAIL) {
    throw new QuarkApiError("Quark failed to save the share");
  }

  // The task payload carries the fids Quark created; the name-based listing is
  // only a fallback for when the task did not report them.
  const taskSavedFids = task === null ? [] : readQuarkTaskSavedFids(task.raw);
  const savedFids = taskSavedFids.length > 0
    ? taskSavedFids
    : await matchSavedFids(
      page,
      toDirFid,
      detail.entries.map((entry) => entry.name),
    );
  // A save changes used capacity.
  userInfoCache.delete("s");

  log.debug(
    `importShareLink: saved ${detail.entries.length} entr(ies) into fid=${toDirFid}`,
  );

  return {
    url,
    pwdId: identity.pwdId,
    toDirFid,
    savedFids,
    taskId: save.taskId === "" ? null : save.taskId,
    taskStatus: task === null
      ? null
      : (task.status === QUARK_TASK_STATUS_FINISH ? "finish" : "fail"),
    ...(includeRaw
      ? {
        raw: {
          token: token.raw,
          detail: detail.pages,
          save: save.raw,
          ...(task !== null ? { task: task.raw } : {}),
        },
      }
      : {}),
  };
}
