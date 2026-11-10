import {
  QUARK_HOME_PAGE_URL,
  QUARK_LOGIN_PAGE_URL,
} from "../consts.ts";
import { log } from "@quark/config";
import { getBrowserContext } from "../browser/page-utils.ts";
import { getOperationQueue } from "../browser/context.ts";
import { loginStatusCache } from "../cache/caches.ts";
import { getQuarkTransport } from "./quark-session.ts";
import { probeQuarkLogin } from "../api/user-info-api.ts";

import type { LoginState, QuarkLoginStatus } from "@quark/contract/schemas";

export interface LoginStatusOptions {
  raw?: boolean;
}

function projectLoginStatus(
  result: QuarkLoginStatus,
  includeRaw: boolean,
): QuarkLoginStatus {
  if (includeRaw) return result;
  const { raw: _raw, ...rest } = result;
  return rest;
}

/**
 * Cheap, non-API login probe for the monitor/guard. It only inspects the
 * renderer URL of each open page: a login renderer is authoritative for the
 * logged-out state, and it never touches the UI or the operation queue.
 */
export function readLoginStateRaw(): LoginState {
  try {
    const context = getBrowserContext();
    const pages = context.pages();
    if (pages.some((page) => page.url().includes(QUARK_LOGIN_PAGE_URL))) {
      return "logged_out";
    }
    if (pages.some((page) => page.url().includes(QUARK_HOME_PAGE_URL))) {
      return "logged_in";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Authoritative login probe: ask Quark's member API from the renderer. A
 * `401`/`31001` answer means the session is not logged in; any other failure
 * is surfaced rather than masked. Cached for 5s.
 */
export function loginStatus(
  options: LoginStatusOptions = {},
): Promise<QuarkLoginStatus> {
  const includeRaw = options.raw === true;
  if (readLoginStateRaw() === "logged_out") {
    loginStatusCache.delete("s");
    return Promise.resolve({ loggedIn: false });
  }
  const cached = loginStatusCache.get("s");
  if (cached !== undefined) {
    return Promise.resolve(projectLoginStatus(cached, includeRaw));
  }

  return getOperationQueue().run(
    "loginStatus",
    { key: "loginStatus" },
    async () => {
      const transport = getQuarkTransport();
      const probe = await probeQuarkLogin(transport);
      log.debug(`loginStatus: loggedIn=${probe.loggedIn}`);

      const result: QuarkLoginStatus = {
        loggedIn: probe.loggedIn,
        raw: probe.raw,
      };
      loginStatusCache.set("s", result);
      return result;
    },
  ).then((result) => projectLoginStatus(result, includeRaw));
}
