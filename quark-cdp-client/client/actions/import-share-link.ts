import { z } from "zod";
import { log } from "../../libs/logger.ts";
import { getHomePage } from "../page-utils.ts";
import { createAction } from "./create-action.ts";

export const SEARCH_TRIGGER_SELECTOR =
  "#root > div > section > section > header > div > div.main-content > div > div > div";
export const SEARCH_INPUT_SELECTOR = "#search-input";

// Quark opens share links as new pages at this origin
const QUARK_SHARE_ORIGIN = "https://pan.quark.cn/s/";
// The share URL is loaded inside this Electron window shell page
const WINDOW_EXPLORER_WEBVIEW_URL = "window-explorer-webview.html";

export interface QuarkImportShareLinkResult {
  url: string;
  savedPath: string;
}

export const importShareLink = createAction(
  "importShareLink",
  async (url: string): Promise<QuarkImportShareLinkResult> => {
    log.debug(`importShareLink: url="${url}"`);

    const homePage = getHomePage();
    await homePage.bringToFront();
    await homePage.waitForLoadState("domcontentloaded");

    const trigger = homePage.locator(SEARCH_TRIGGER_SELECTOR).first();
    const input = homePage.locator(SEARCH_INPUT_SELECTOR).first();

    // Click the search trigger and wait for the input to appear; retry once
    // in case the app needs a moment to settle (e.g. after closing a prior window)
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

    // Wait for the search dropdown to populate before submitting
    await homePage.waitForTimeout(1_500);

    const context = homePage.context();

    // Snapshot known pages (by object identity) before pressing Enter, so we
    // can identify the new window-explorer-webview shell that opens with the share
    const knownPages = new Set(context.pages());

    // Register listener before pressing Enter so we don't miss the new page event
    const sharePagePromise = context.waitForEvent("page", {
      predicate: (page) => page.url().startsWith(QUARK_SHARE_ORIGIN),
      timeout: 15_000,
    });

    await input.press("Enter");

    const sharePage = await sharePagePromise;
    await sharePage.waitForLoadState("domcontentloaded");
    log.debug(`importShareLink: share page opened at "${sharePage.url()}"`);

    // Click "保存到网盘"
    const saveBtn = sharePage.locator("button.ant-btn.share-save").first();
    await saveBtn.waitFor({ state: "visible", timeout: 15_000 });
    await saveBtn.evaluate((el) => (el as HTMLElement).click());

    // Wait for the save-success modal and read the save path
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

    log.debug(`importShareLink: saved to "${savedPath}", closing share window`);

    // Close the Electron window shell that contains the share page.
    // CDP Target.closeTarget hangs waiting for Electron's acknowledgement, so
    // we fire window.close() from within the page instead and ignore the
    // resulting navigation error when the page tears down.
    const windowShell = context.pages().find(
      (p) =>
        !knownPages.has(p) && p.url().includes(WINDOW_EXPLORER_WEBVIEW_URL),
    );
    const pageToClose = windowShell ?? sharePage;
    await pageToClose.evaluate(() => window.close()).catch(() => undefined);

    return { url, savedPath };
  },
  {
    description: [
      "Import a Quark Cloud Drive share link — opens the URL inside the",
      "Quark client, clicks through the \"save to my drive\" flow, and",
      "returns the path where the shared content was saved.",
      "",
      "Input is a full https URL of a Quark share (e.g.",
      "`https://pan.quark.cn/s/...`). Plain `pan.quark.cn` URLs work; other",
      "domains will fail at the navigation step.",
      "",
      "Returns `{url, savedPath}` where `savedPath` is the destination",
      "folder inside the user's drive. Behind the scenes a temporary web-",
      "view window is opened to drive the import — it's closed before the",
      "call returns, so callers don't need to clean anything up.",
      "",
      "Requires the user to be logged in.",
    ].join("\n"),
    mcp: {
      name: "import_share_link",
      input: z.object({
        url: z.string().describe(
          "Full HTTPS share URL from pan.quark.cn (e.g. " +
            "`https://pan.quark.cn/s/abc123`). Passwords/extract codes are " +
            "NOT currently supported.",
        ),
      }),
    },
  },
);
