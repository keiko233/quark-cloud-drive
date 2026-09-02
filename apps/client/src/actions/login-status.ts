import {
  QUARK_HOME_PAGE_URL,
  QUARK_LOGIN_PAGE_URL,
  QUARK_MEMBER_PAGE_URL,
} from "../consts.ts";
import { log } from "../logger.ts";
import { findPageByUrl } from "../utils.ts";
import { getBrowserContext } from "../browser/page-utils.ts";
import { getOperationQueue } from "../browser/context.ts";
import { loginStatusCache } from "../cache/caches.ts";

import type { LoginState } from "@quark/contract/schemas";

/**
 * Cheap login probe for the monitor/guard. A login renderer is authoritative
 * for the logged-out state and does not touch the UI or operation queue.
 */
export function readLoginStateRaw(): LoginState {
  try {
    const context = getBrowserContext();
    const pages = context.pages();
    if (pages.some((page) => page.url().includes(QUARK_LOGIN_PAGE_URL))) {
      return "logged_out";
    }
    const home = pages.some((page) => page.url().includes(QUARK_HOME_PAGE_URL));
    const memberOnly = pages.some((page) =>
      page.url().includes(QUARK_MEMBER_PAGE_URL)
    ) && !home;
    if (home && !memberOnly) return "logged_in";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Queued public entry point. Cached for 5s. */
export function loginStatus(): Promise<{ loggedIn: boolean }> {
  const cached = loginStatusCache.get("s");
  if (cached !== undefined) return Promise.resolve(cached);

  return getOperationQueue().run(
    "loginStatus",
    { key: "loginStatus" },
    async () => {
      log.debug("loginStatus: start");

      const context = getBrowserContext();
      // This check is intentionally first: the renderer is the stable signal
      // during QR login, before the home page exists or is fully hydrated.
      const rendererState = readLoginStateRaw();
      if (rendererState === "logged_out") {
        log.debug("loginStatus: login renderer found, not logged in");
        const result = { loggedIn: false };
        loginStatusCache.set("s", result);
        return result;
      }
      const homePage = findPageByUrl(context, QUARK_HOME_PAGE_URL);

      if (!homePage) {
        throw new Error(
          `Login status page not found: ${QUARK_HOME_PAGE_URL} or ${QUARK_LOGIN_PAGE_URL}`,
        );
      }

      await homePage.bringToFront();
      await homePage.waitForLoadState("domcontentloaded");

      const memberContent = homePage.locator(".member-content-container")
        .first();
      await memberContent.waitFor({ state: "visible", timeout: 10_000 });

      const loginButton = memberContent
        .locator("div.member-login")
        .filter({ hasText: "立即登录" })
        .first();

      const loggedIn = await loginButton.count() === 0;
      log.debug(`loginStatus: loggedIn=${loggedIn}`);
      const result = { loggedIn };
      loginStatusCache.set("s", result);
      return result;
    },
  );
}
