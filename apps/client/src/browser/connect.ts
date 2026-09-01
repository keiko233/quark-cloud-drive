import { chromium } from "playwright";
import { log } from "../logger.ts";
import { CDP_URL } from "../env.ts";
import { setBrowser } from "./context.ts";
import { ensureQuarkAwake } from "../monitor/wake.ts";

export async function connect(): Promise<void> {
  // Always wake before connecting: if the server idle-stopped Quark while we
  // were disconnected, /start brings it back up and we wait for the CDP port
  // to come online. Idempotent if Quark is already running.
  log.debug("ensuring Quark is awake before connect");
  await ensureQuarkAwake();

  log.debug(`connecting to CDP at ${CDP_URL}...`);

  const browser = await chromium.connectOverCDP(CDP_URL);
  log.debug(`connected to CDP, browser version: ${browser.version()}`);
  setBrowser(browser);

  browser.on("disconnected", () => {
    setBrowser(null);
    log.debug("CDP connection disconnected, will reconnect...");
  });

  const context = browser.contexts()[0];
  if (!context) {
    log.warn(
      "No BrowserContext found yet; releasing connection and retrying",
    );
    setBrowser(null);
    return;
  }

  const pages = context.pages();

  if (pages.length === 0) {
    log.warn("No pages found yet; releasing connection and retrying");
    setBrowser(null);
    return;
  }

  for (const page of pages) {
    const title = await page.title();
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
  await new Promise<void>((resolve) => {
    browser.on("disconnected", () => resolve());
  });
}
