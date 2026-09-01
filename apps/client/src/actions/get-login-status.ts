import { QUARK_HOME_PAGE_URL, QUARK_LOGIN_PAGE_URL } from "../consts.ts";
import { log } from "../logger.ts";
import { findPageByUrl } from "../utils.ts";
import { getBrowserContext } from "../browser/page-utils.ts";
import { getOperationQueue } from "../browser/context.ts";
import { loginStatusCache } from "../cache/caches.ts";

/** Queued public entry point. Cached for 5s. */
export function getLoginStatus(): Promise<{ loggedIn: boolean }> {
  const cached = loginStatusCache.get("s");
  if (cached !== undefined) return Promise.resolve(cached);

  return getOperationQueue().run(
    "getLoginStatus",
    { key: "loginStatus" },
    async () => {
      log.debug("getLoginStatus: start");

      const context = getBrowserContext();
      const homePage = findPageByUrl(context, QUARK_HOME_PAGE_URL);

      if (!homePage) {
        const loginPage = findPageByUrl(context, QUARK_LOGIN_PAGE_URL);
        if (loginPage) {
          log.debug("getLoginStatus: login page found, not logged in");
          const result = { loggedIn: false };
          loginStatusCache.set("s", result);
          return result;
        }
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
      log.debug(`getLoginStatus: loggedIn=${loggedIn}`);
      const result = { loggedIn };
      loginStatusCache.set("s", result);
      return result;
    },
  );
}
