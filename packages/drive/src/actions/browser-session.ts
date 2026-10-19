import type { Page } from "playwright";
import { getHomePage } from "../browser/page-utils.ts";

/**
 * The one attachment point for every Quark API call.
 *
 * Business requests are issued as same-origin `fetch` calls from the logged-in
 * renderer, so Quark's session cookie is applied by the browser and never
 * leaves it. The page is used purely as a JavaScript + network context: no DOM
 * node is queried, clicked, or scrolled by any business action.
 */
export async function getQuarkPage(): Promise<Page> {
  const page = getHomePage();
  await page.waitForLoadState("domcontentloaded");
  return page;
}
