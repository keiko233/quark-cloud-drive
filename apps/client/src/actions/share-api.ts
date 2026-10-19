import type { Page } from "playwright";
import {
  asObjectOrNull,
  buildQuarkApiUrl,
  QuarkApiError,
  readFiniteNumber,
  readString,
  requestQuarkApi,
} from "./renderer-http.ts";

/**
 * Quark share APIs, API only.
 *
 * `POST /share/sharepage/token` unlocks a share, `GET /share/sharepage/detail`
 * lists its top level (each entry carries the `share_fid_token` needed to save
 * it), and `POST /share/sharepage/save` starts an async save task that is
 * polled through `GET /1/clouddrive/task`.
 */

const SHARE_API_TIMEOUT_MS = 8_000;
const SHARE_DETAIL_PAGE_SIZE = 50;
const SHARE_DETAIL_MAX_PAGES = 100;
const SHARE_TASK_POLL_INTERVAL_MS = 1_000;
const SHARE_TASK_POLL_TIMEOUT_MS = 60_000;

export const QUARK_TASK_STATUS_FINISH = 2;
export const QUARK_TASK_STATUS_FAIL = 3;

type JsonObject = Record<string, unknown>;

export interface QuarkShareIdentity {
  pwdId: string;
  passcode: string | null;
}

export interface QuarkShareEntry {
  fid: string;
  fidToken: string;
  name: string;
  dir: boolean;
  raw: JsonObject;
}

export interface QuarkShareSaveDir {
  fid: string;
  name: string;
  raw: JsonObject;
}

export interface QuarkShareTaskResult {
  taskId: string;
  status: number;
  statusName: string;
  raw: JsonObject;
}

export interface QuarkShareSaveResult {
  taskId: string;
  raw: JsonObject;
}

/** Extract the share id (and optional passcode) from a share URL or raw id. */
export function parseQuarkShareUrl(raw: string): QuarkShareIdentity {
  const trimmed = raw.trim();
  if (trimmed === "") throw new QuarkApiError("share URL was empty");

  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    url = null;
  }

  const source = url !== null
    ? `${url.pathname}${url.hash}`
    : trimmed.replace(/^s\//, "");
  const match = /(?:^|\/)s\/([A-Za-z0-9_-]+)/.exec(source);
  const pwdId = match?.[1] ?? (/^[A-Za-z0-9_-]+$/.test(source) ? source : "");
  if (pwdId === "") {
    throw new QuarkApiError("share URL did not contain a share id");
  }

  const fragmentParams = new URLSearchParams(
    (url?.hash ?? "").replace(/^#/, ""),
  );
  const passcode = url?.searchParams.get("pwd") ?? fragmentParams.get("pwd");
  return {
    pwdId,
    passcode: passcode !== null && passcode !== "" ? passcode : null,
  };
}

export function buildQuarkShareTokenUrl(): string {
  return buildQuarkApiUrl("/1/clouddrive/share/sharepage/token");
}

export function buildQuarkShareDetailUrl(
  pwdId: string,
  stoken: string,
  page = 1,
  size = SHARE_DETAIL_PAGE_SIZE,
): string {
  return buildQuarkApiUrl("/1/clouddrive/share/sharepage/detail", {
    pwd_id: pwdId,
    stoken,
    pdir_fid: "0",
    force: "0",
    _page: page,
    _size: size,
    _fetch_banner: "1",
    _fetch_share: "1",
    _fetch_total: "1",
    fetch_update_flag: "1",
    ver: "2",
  });
}

export function buildQuarkShareSaveUrl(): string {
  return buildQuarkApiUrl("/1/clouddrive/share/sharepage/save");
}

export function buildQuarkShareDirUrl(pwdId?: string): string {
  return buildQuarkApiUrl(
    "/1/clouddrive/share/sharepage/dir",
    pwdId === undefined ? { aver: "1" } : { pwd_id: pwdId },
  );
}

export function buildQuarkTaskPollUrl(
  taskId: string,
  retryIndex: number,
): string {
  return buildQuarkApiUrl("/1/clouddrive/task", {
    task_id: taskId,
    retry_index: retryIndex,
  });
}

export async function fetchQuarkShareTokenInBrowser(
  page: Page,
  identity: QuarkShareIdentity,
): Promise<{ stoken: string; raw: JsonObject }> {
  const envelope = await requestQuarkApi(page, {
    method: "POST",
    url: buildQuarkShareTokenUrl(),
    body: {
      pwd_id: identity.pwdId,
      passcode: identity.passcode ?? "",
      support_visit_limit_private_share: true,
    },
    timeoutMs: SHARE_API_TIMEOUT_MS,
  });

  const data = asObjectOrNull(envelope.data) ?? {};
  const stoken = readString(data.stoken);
  if (stoken === undefined) {
    throw new QuarkApiError("share token response had no stoken");
  }
  return { stoken, raw: data };
}

function parseShareEntry(value: unknown): QuarkShareEntry {
  const entry = asObjectOrNull(value);
  const fid = readString(entry?.fid);
  const name = readString(entry?.file_name);
  const fidToken = readString(entry?.share_fid_token);
  if (
    !entry || fid === undefined || name === undefined || fidToken === undefined
  ) {
    throw new QuarkApiError("share detail returned an invalid entry");
  }
  return { fid, fidToken, name, dir: entry.dir === true, raw: entry };
}

export async function fetchQuarkShareDetailInBrowser(
  page: Page,
  pwdId: string,
  stoken: string,
): Promise<
  { entries: QuarkShareEntry[]; pages: JsonObject[]; raw: JsonObject }
> {
  const entries: QuarkShareEntry[] = [];
  const pages: JsonObject[] = [];
  const seen = new Set<string>();

  for (let pageNumber = 1; pageNumber <= SHARE_DETAIL_MAX_PAGES; pageNumber++) {
    const envelope = await requestQuarkApi(page, {
      url: buildQuarkShareDetailUrl(pwdId, stoken, pageNumber),
      timeoutMs: SHARE_API_TIMEOUT_MS,
    });
    const data = asObjectOrNull(envelope.data);
    if (!data || !Array.isArray(data.list)) {
      throw new QuarkApiError("share detail returned invalid data");
    }
    pages.push(data);

    for (const raw of data.list) {
      const entry = parseShareEntry(raw);
      if (seen.has(entry.fid)) continue;
      seen.add(entry.fid);
      entries.push(entry);
    }

    if (data.list.length < SHARE_DETAIL_PAGE_SIZE) break;
    if (pageNumber === SHARE_DETAIL_MAX_PAGES) {
      throw new QuarkApiError("share detail pagination limit exceeded");
    }
  }

  return { entries, pages, raw: { pages } };
}

/** Quark's default save location for a share (`来自：分享`). */
export async function fetchQuarkShareSaveDirInBrowser(
  page: Page,
  pwdId?: string,
): Promise<QuarkShareSaveDir> {
  const envelope = await requestQuarkApi(page, {
    url: buildQuarkShareDirUrl(pwdId),
    timeoutMs: SHARE_API_TIMEOUT_MS,
  });
  const data = asObjectOrNull(envelope.data) ?? {};
  const fid = readString(data.pdir_fid) ?? readString(data.dir);
  if (fid === undefined) {
    throw new QuarkApiError("share dir response had no folder id");
  }
  return { fid, name: readString(data.pdir_name) ?? "", raw: data };
}

export async function saveQuarkShareInBrowser(
  page: Page,
  input: {
    pwdId: string;
    stoken: string;
    toDirFid: string;
    entries: QuarkShareEntry[];
  },
): Promise<QuarkShareSaveResult> {
  const envelope = await requestQuarkApi(page, {
    method: "POST",
    url: buildQuarkShareSaveUrl(),
    body: {
      pwd_id: input.pwdId,
      stoken: input.stoken,
      to_pdir_fid: input.toDirFid,
      pdir_fid: input.toDirFid,
      fid_list: input.entries.map((entry) => entry.fid),
      fid_token_list: input.entries.map((entry) => entry.fidToken),
      mode: "inc_single",
    },
    timeoutMs: SHARE_API_TIMEOUT_MS,
  });

  const data = asObjectOrNull(envelope.data) ?? {};
  return { taskId: readString(data.task_id) ?? "", raw: data };
}

function taskStatusName(status: number): string {
  switch (status) {
    case 0:
      return "todo";
    case 1:
      return "running";
    case QUARK_TASK_STATUS_FINISH:
      return "finish";
    case QUARK_TASK_STATUS_FAIL:
      return "fail";
    case 4:
      return "pause";
    default:
      throw new QuarkApiError(`task status ${status} is not recognized`);
  }
}

/** Poll a save task until it finishes. */
export async function pollQuarkTaskInBrowser(
  page: Page,
  taskId: string,
): Promise<QuarkShareTaskResult> {
  if (taskId === "") {
    throw new QuarkApiError("save task had no task id");
  }

  const deadline = Date.now() + SHARE_TASK_POLL_TIMEOUT_MS;
  let retryIndex = 0;
  let payload: JsonObject = {};
  let status = 0;

  while (
    status !== QUARK_TASK_STATUS_FINISH && status !== QUARK_TASK_STATUS_FAIL
  ) {
    if (Date.now() >= deadline) {
      throw new QuarkApiError("save task did not finish in time");
    }
    await new Promise((resolve) =>
      setTimeout(resolve, SHARE_TASK_POLL_INTERVAL_MS)
    );
    const envelope = await requestQuarkApi(page, {
      url: buildQuarkTaskPollUrl(taskId, retryIndex),
      timeoutMs: SHARE_API_TIMEOUT_MS,
    });
    retryIndex++;
    payload = asObjectOrNull(envelope.data) ?? payload;
    status = readFiniteNumber(payload.status) ?? status;
  }

  return {
    taskId,
    status,
    statusName: taskStatusName(status),
    raw: payload,
  };
}
