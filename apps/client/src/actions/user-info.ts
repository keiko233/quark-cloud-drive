import { log } from "../logger.ts";
import { getHomePage } from "../browser/page-utils.ts";
import { getOperationQueue } from "../browser/context.ts";
import { userInfoCache } from "../cache/caches.ts";

/** Queued public entry point. Cached for 30s. */
export function userInfo(): Promise<{ capacity: string }> {
  const cached = userInfoCache.get("s");
  if (cached !== undefined) return Promise.resolve(cached);

  return getOperationQueue().run(
    "userInfo",
    { key: "userInfo" },
    async () => {
      log.debug("userInfo: start");

      const homePage = getHomePage();
      await homePage.bringToFront();
      await homePage.waitForLoadState("domcontentloaded");

      const capacityNumber = homePage.locator("div.capacity-number").first();
      await capacityNumber.waitFor({ state: "visible", timeout: 10_000 });

      const capacity = (await capacityNumber.textContent())?.trim() ?? "";
      log.debug(`userInfo: capacity="${capacity}"`);
      const result = { capacity };
      userInfoCache.set("s", result);
      return result;
    },
  );
}
