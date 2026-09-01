import { log } from "../../libs/logger.ts";
import { TtlCache } from "../cache.ts";
import { getHomePage } from "../page-utils.ts";
import { createAction } from "./create-action.ts";

const userInfoCache = new TtlCache<"s", { capacity: string }>(30_000);

export const getUserInfo = createAction(
  "getUserInfo",
  async () => {
    log.debug("getUserInfo: start");

    const homePage = getHomePage();
    await homePage.bringToFront();
    await homePage.waitForLoadState("domcontentloaded");

    const capacityNumber = homePage.locator("div.capacity-number").first();
    await capacityNumber.waitFor({ state: "visible", timeout: 10_000 });

    const capacity = (await capacityNumber.textContent())?.trim() ?? "";
    log.debug(`getUserInfo: capacity="${capacity}"`);
    return { capacity };
  },
  {
    description: [
      "Return basic account info — currently just the storage capacity string",
      "Quark renders on the home page (e.g. `1.2T/2T`, `512G/1T`).",
      "",
      "Requires the user to be logged in. If not, the underlying `capacity-",
      "number` element won't render and the call throws a Playwright wait",
      "timeout — guard with `get_login_status` first if you're unsure.",
      "",
      "Cached for 30 s.",
    ].join("\n"),
    mcp: { name: "get_user_info" },
    cache: { cache: userInfoCache, key: () => "s" },
  },
);
