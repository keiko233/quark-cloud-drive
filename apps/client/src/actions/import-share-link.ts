import type {
  ImportShareLinkStreamEvent,
  QuarkImportShareLinkResult,
} from "@quark/contract/schemas";
import { log } from "../logger.ts";
import { getOperationQueue } from "../browser/context.ts";
import { getHomePage } from "../browser/page-utils.ts";
import { fileListCache } from "../cache/caches.ts";

export const SEARCH_TRIGGER_SELECTOR =
  "#root > div > section > section > header > div > div.main-content > div > div > div";
export const SEARCH_INPUT_SELECTOR = "#search-input";

// Quark opens share links as new pages at this origin
const QUARK_SHARE_ORIGIN = "https://pan.quark.cn/s/";
// The share URL is loaded inside this Electron window shell page
const WINDOW_EXPLORER_WEBVIEW_URL = "window-explorer-webview.html";

/**
 * Queued streaming entry point. Yields `opening`/`saving` progress, then
 * returns `{url, savedPath}`.
 */
export function importShareLink(
  url: string,
): Promise<
  AsyncGenerator<ImportShareLinkStreamEvent, QuarkImportShareLinkResult>
> {
  return getOperationQueue().runStreaming(
    "importShareLink",
    { key: `importShareLink:${url}`, priority: 1 },
    async function* () {
      log.debug(`importShareLink: url="${url}"`);
      yield { type: "opening", url };

      const homePage = getHomePage();
      await homePage.bringToFront();
      await homePage.waitForLoadState("domcontentloaded");

      const trigger = homePage.locator(SEARCH_TRIGGER_SELECTOR).first();
      const input = homePage.locator(SEARCH_INPUT_SELECTOR).first();

      for (let attempt = 0; attempt < 2; attempt++) {
        await trigger.evaluate((el) => (el as HTMLElement).click());
        const appeared = await input
          .waitFor({ state: "visible", timeout: 4_000 })
          .then(() => true)
          .catch(() => false);
        if (appeared) break;
        await homePage.waitForTimeout(800);
      }
      await input.waitFor({ state: "visible", timeout: 5_000 });

      await input.fill(url);

      await homePage.waitForTimeout(1_500);

      const context = homePage.context();

      const knownPages = new Set(context.pages());

      const sharePagePromise = context.waitForEvent("page", {
        predicate: (page) => page.url().startsWith(QUARK_SHARE_ORIGIN),
        timeout: 15_000,
      });

      await input.press("Enter");

      const sharePage = await sharePagePromise;
      await sharePage.waitForLoadState("domcontentloaded");
      log.debug(`importShareLink: share page opened at "${sharePage.url()}"`);

      yield { type: "saving", url };

      const saveBtn = sharePage.locator("button.ant-btn.share-save").first();
      await saveBtn.waitFor({ state: "visible", timeout: 15_000 });
      await saveBtn.evaluate((el) => (el as HTMLElement).click());

      const successModal = sharePage
        .locator(".save-share-file-success-modal")
        .first();
      await successModal.waitFor({ state: "visible", timeout: 10_000 });

      const savedPath = await successModal
        .locator(".save-path-wrap .path")
        .first()
        .textContent()
        .then((t) => (t ?? "").trim())
        .catch(() => "");

      log.debug(
        `importShareLink: saved to "${savedPath}", closing share window`,
      );

      const windowShell = context.pages().find(
        (p) =>
          !knownPages.has(p) && p.url().includes(WINDOW_EXPLORER_WEBVIEW_URL),
      );
      const pageToClose = windowShell ?? sharePage;
      await pageToClose.evaluate(() => self.close()).catch(() => undefined);

      // Importing a share can add rows to the file list — drop the cache.
      fileListCache.clear();
      return { url, savedPath };
    },
  );
}
