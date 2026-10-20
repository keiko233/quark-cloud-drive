import { chromium } from "playwright";
import { CDP_URL, log } from "@quark/config";
import {
  QUARK_HOME_PAGE_URL,
  QUARK_LOGIN_PAGE_URL,
  setBrowser,
} from "@quark/drive";
import { autoWakeBlockReason, ensureQuarkAwake } from "../monitor/wake.ts";

export async function connect(): Promise<void> {
  // Always wake before connecting: if the server idle-stopped Quark while we
  // were disconnected, /start brings it back up and we wait for the CDP port
  // to come online. Idempotent if Quark is already running.
  const blocked = await autoWakeBlockReason();
  if (blocked) {
    throw new Error(`automatic wake is blocked: ${blocked}`);
  }
  log.debug("ensuring Quark is awake before connect");
  await ensureQuarkAwake();

  log.debug(`connecting to CDP at ${CDP_URL}...`);

  const browser = await chromium.connectOverCDP(CDP_URL);
  log.debug(`connected to CDP, browser version: ${browser.version()}`);

  try {
    await waitForRenderer(browser);
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
  setBrowser(browser);

  browser.on("disconnected", () => {
    setBrowser(null);
    log.debug("CDP connection disconnected, will reconnect...");
  });

  const pages = browser.contexts()[0]!.pages();

  for (const page of pages) {
    const title = await page.title().catch(() => "(unavailable)");
    log.debug(`attached to page: [${title}] ${page.url()}`);

    page.on("request", (req) => {
      log.trace("REQ", req.method(), req.url());
    });

    page.on("response", (res) => {
      log.trace("RES", res.status(), res.url());
    });

    page.on("close", () => log.debug(`page closed: [${title}] ${page.url()}`));
  }

  // wait until browser is disconnected
  if (!browser.isConnected()) return;
  await new Promise<void>((resolve) => {
    browser.on("disconnected", () => resolve());
  });
}

/** CDP can listen while Wine still shows an empty white renderer. */
export async function waitForRenderer(
  browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>,
  { timeoutMs = 30_000, pollMs = 2_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let reason = "home renderer has not opened";
  while (Date.now() < deadline && browser.isConnected()) {
    const page = browser.contexts()[0]?.pages().find((candidate) =>
      [QUARK_HOME_PAGE_URL, QUARK_LOGIN_PAGE_URL].some((url) =>
        candidate.url().includes(url)
      )
    );
    if (page) {
      try {
        const bodyReady = await withTimeout(
          page.evaluate(() => (document.body?.querySelectorAll("*").length ?? 0) > 5),
          2_000,
        );
        if (bodyReady) {
          const png = await page.screenshot({ type: "png", timeout: 5_000 });
          const painted = await withTimeout(
            page.evaluate(async (base64) => {
              const image = new Image();
              image.src = `data:image/png;base64,${base64}`;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = 32;
              canvas.height = 24;
              const context = canvas.getContext("2d")!;
              context.drawImage(image, 0, 0, 32, 24);
              const pixels = context.getImageData(0, 0, 32, 24).data;
              let colored = 0;
              for (let i = 0; i < pixels.length; i += 4) {
                if (
                  pixels[i]! < 245 || pixels[i + 1]! < 245 ||
                  pixels[i + 2]! < 245
                ) colored++;
              }
              return colored;
            }, png.toString("base64")),
            5_000,
          );
          if (painted >= 8) return;
          reason = `renderer screenshot is blank (${painted}/768 non-white samples)`;
        } else {
          reason = "renderer DOM is empty";
        }
      } catch (error) {
        reason = `renderer probe failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Quark renderer not ready after ${timeoutMs}ms: ${reason}`);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("pixel probe timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
