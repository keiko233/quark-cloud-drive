import type { Page } from "playwright";
import {
  findPageByUrl,
  getBrowserContext,
  getOperationQueue,
  QUARK_HOME_PAGE_URL,
  QUARK_LOGIN_PAGE_URL,
  QUARK_MEMBER_PAGE_URL,
} from "@quark/drive";
import { withDriveSession } from "../guard.ts";
import { clearLoggedOutStopMarker } from "../monitor/status.ts";
import { sleeper } from "../rpc/runtime.ts";

/** Only sign-in interacts with the Quark window. */
async function findLoginPage(): Promise<Page> {
  const context = getBrowserContext();
  const existing = findPageByUrl(context, QUARK_LOGIN_PAGE_URL) ??
    findPageByUrl(context, QUARK_MEMBER_PAGE_URL);
  if (existing) return existing;

  const home = findPageByUrl(context, QUARK_HOME_PAGE_URL);
  if (!home) throw new Error("Quark login or home window is unavailable");
  await home.bringToFront();
  // Electron 18's Chromium lacks the visibility API used by modern locators.
  const button = await home.waitForFunction(() => {
    const element = Array.from(document.querySelectorAll("div.member-login"))
      .find((node) => node.textContent?.includes("立即登录") && node.getClientRects().length);
    if (!element) return false;
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return rect.width && rect.height
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : false;
  }, undefined, { timeout: 10_000, polling: 200 });
  const point = await button.jsonValue();
  await button.dispose();
  if (!point) throw new Error("Quark login button is unavailable");
  const [page] = await Promise.all([
    context.waitForEvent("page", { timeout: 10_000 }),
    home.mouse.click(point.x, point.y),
  ]);
  return page;
}

/** Export the rendered QR pixels without Playwright's locator screenshot. */
async function readLoginQrPng(page: Page): Promise<Uint8Array> {
  const handle = await page.waitForFunction(() => {
    const source = document.querySelector<HTMLCanvasElement>(
      ".qrcode-display canvas, .qrcode-container canvas",
    );
    const bounds = source?.getBoundingClientRect();
    if (!source?.width || !source.height || !bounds?.width || !bounds.height) return false;
    const context = source.getContext("2d");
    if (!context) return false;
    const { data } = context.getImageData(0, 0, source.width, source.height);
    // A mounted canvas can still be blank while the QR request is in flight.
    let hasDarkPixel = false;
    for (let i = 0; i < data.length; i += 16) {
      if (data[i + 3]! > 127 && data[i]! < 128 && data[i + 1]! < 128 && data[i + 2]! < 128) {
        hasDarkPixel = true;
        break;
      }
    }
    if (!hasDarkPixel) return false;

    const output = document.createElement("canvas");
    const margin = 16;
    output.width = source.width + margin * 2;
    output.height = source.height + margin * 2;
    const ctx = output.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.drawImage(source, margin, margin);
    return output.toDataURL("image/png").slice("data:image/png;base64,".length);
  }, undefined, { timeout: 10_000, polling: 250 });
  const base64 = await handle.jsonValue();
  await handle.dispose();
  if (!base64) throw new Error("Quark did not render a login QR code");
  return Buffer.from(base64, "base64");
}

export async function loginQRCode(signal?: AbortSignal): Promise<Uint8Array> {
  await clearLoggedOutStopMarker();
  sleeper.clearDecision();
  return withDriveSession(() => getOperationQueue().run("loginQRCode", { signal }, async () => {
    const page = await findLoginPage();
    await page.bringToFront();
    // Reloading the standalone login renderer can hang Wine. Use the current
    // QR from the client, which manages the challenge and its own expiration.
    const png = await readLoginQrPng(page);
    sleeper.holdForLogin();
    return png;
  }), { login: false });
}
