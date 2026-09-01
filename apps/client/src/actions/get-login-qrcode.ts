import type { BrowserContext, Page } from "playwright";
import {
  QUARK_HOME_PAGE_URL,
  QUARK_LOGIN_PAGE_URL,
  QUARK_MEMBER_PAGE_URL,
} from "../consts.ts";
import { findPageByUrl } from "../utils.ts";
import { log } from "../logger.ts";
import { getBrowserContext } from "../browser/page-utils.ts";
import { getOperationQueue } from "../browser/context.ts";

async function getMemberPage(
  context: BrowserContext,
  homePage: Page,
): Promise<{ memberPage: Page; createdByClick: boolean }> {
  const existingPage = findPageByUrl(context, QUARK_MEMBER_PAGE_URL);
  if (existingPage) {
    log.trace("getMemberPage: reusing existing member page");
    return { memberPage: existingPage, createdByClick: false };
  }

  const existingLoginPage = findPageByUrl(context, QUARK_LOGIN_PAGE_URL);
  if (existingLoginPage) {
    log.trace("getMemberPage: reusing existing login page");
    return { memberPage: existingLoginPage, createdByClick: false };
  }

  log.trace("getMemberPage: clicking login button to open member page");
  const loginButton = homePage
    .locator("div.member-login")
    .filter({ hasText: "立即登录" })
    .first();

  await loginButton.waitFor({ state: "visible" });

  const pagePromise = context.waitForEvent("page", { timeout: 10_000 });
  await loginButton.click();

  const memberPage = await pagePromise;
  await memberPage.waitForLoadState("domcontentloaded");

  return { memberPage, createdByClick: true };
}

async function screenshotQRCode(
  page: Page,
  options: { refresh?: boolean } = {},
): Promise<Uint8Array> {
  log.trace(`screenshotQRCode: refresh=${options.refresh ?? false}`);
  await page.bringToFront();

  if (options.refresh) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
  } else {
    await page.waitForLoadState("domcontentloaded");
  }

  const qrCode = page.locator([
    ".qrcode-display canvas",
    ".qrcode-container canvas",
    ".qrcode-display",
    ".qrcode-container",
  ].join(", ")).first();

  await qrCode.waitFor({ state: "visible", timeout: 10_000 });
  log.trace("screenshotQRCode: capturing QR code screenshot");
  return await qrCode.screenshot({ type: "png" });
}

/** Queued public entry point. Returns the QR code PNG bytes. */
export function getLoginQRCode(): Promise<Uint8Array> {
  return getOperationQueue().run("getLoginQRCode", {}, async () => {
    log.debug("getLoginQRCode: start");

    const context = getBrowserContext();
    const homePage = findPageByUrl(context, QUARK_HOME_PAGE_URL);

    if (!homePage) {
      const loginPage = findPageByUrl(context, QUARK_LOGIN_PAGE_URL);
      if (loginPage) {
        log.debug("getLoginQRCode: using existing login page");
        return await screenshotQRCode(loginPage, { refresh: true });
      }
      throw new Error(
        `Login QR code page not found: ${QUARK_HOME_PAGE_URL} or ${QUARK_LOGIN_PAGE_URL}`,
      );
    }

    await homePage.bringToFront();

    const { memberPage } = await getMemberPage(context, homePage);
    log.debug("getLoginQRCode: capturing QR code");
    return await screenshotQRCode(memberPage, { refresh: true });
  });
}
