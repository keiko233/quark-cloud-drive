import type { BrowserContext, Page } from "playwright";
import {
  QUARK_HOME_PAGE_URL,
  QUARK_LOGIN_PAGE_URL,
  QUARK_MEMBER_PAGE_URL,
} from "../../consts.ts";
import { findPageByUrl } from "../../libs/utils.ts";
import { log } from "../../libs/logger.ts";
import { getBrowserContext } from "../page-utils.ts";
import { createAction } from "./create-action.ts";

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

export const getLoginQRCode = createAction(
  "getLoginQRCode",
  async () => {
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
  },
  {
    description: [
      "Capture the Quark login QR code as a PNG image.",
      "",
      "Use this to log a fresh account in: render the PNG, have the user scan",
      "it with the Quark mobile app, then poll `get_login_status` until it",
      "returns `{loggedIn: true}`. Each call re-opens or refreshes the login",
      "page so the QR is current (Quark rotates QRs every ~minute).",
      "",
      "Returns the raw PNG bytes — over HTTP as `image/png`, over MCP as a",
      "base64-encoded image content block. No input.",
      "",
      "Side effects: brings the Quark window forward, may open the membership",
      "/ login page tab if it isn't already open, reloads it to refresh the QR.",
    ].join("\n"),
    mcp: { name: "get_login_qrcode" },
  },
);
