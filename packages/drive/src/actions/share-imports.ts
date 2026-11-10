import type { QuarkShareImport, QuarkShareSubmission } from "@quark/contract/schemas";
import { userInfoCache } from "../cache/caches.ts";
import {
  fetchQuarkShareDetail,
  fetchQuarkShareSaveDir,
  fetchQuarkShareToken,
  parseQuarkShareUrl,
  readQuarkShareTask,
  saveQuarkShare,
} from "../api/share-api.ts";
import { QuarkApiError } from "../api/http.ts";
import { getQuarkTransport } from "./quark-session.ts";

export async function saveShare(input: {
  url: string;
  passcode?: string;
  toFid?: string;
}): Promise<QuarkShareSubmission> {
  const identity = parseQuarkShareUrl(input.url);
  const transport = getQuarkTransport();
  const { stoken } = await fetchQuarkShareToken(transport, {
    pwdId: identity.pwdId,
    passcode: input.passcode ?? identity.passcode,
  });
  const { entries } = await fetchQuarkShareDetail(transport, identity.pwdId, stoken);
  if (!entries.length) throw new QuarkApiError("Share contained no entries to save");

  const toDirFid = input.toFid ?? (await fetchQuarkShareSaveDir(transport)).fid;
  const { taskId } = await saveQuarkShare(transport, {
    pwdId: identity.pwdId,
    stoken,
    toDirFid,
    entries,
  });

  return { taskId, toDirFid, status: "submitted" };
}

export async function getShareImport(input: {
  taskId: string;
  retryIndex?: number;
}): Promise<QuarkShareImport> {
  const result = await readQuarkShareTask(getQuarkTransport(), input.taskId, input.retryIndex ?? 0);
  if (result.status === "completed") userInfoCache.delete("s");
  return result;
}
