import { chromium } from "npm:playwright";
import { log } from "../libs/logger.ts";
import { CDP_URL } from "../libs/env.ts";
import { ensureQuarkAwake } from "../libs/manager.ts";
import { setBrowser } from "./browser.ts";

export async function connect(): Promise<void> {
  // Always wake before connecting: if the manager idle-stopped Quark while we
  // were disconnected, /start brings it back up and we wait for the CDP port
  // to come online before Playwright tries the handshake. Idempotent if Quark
  // is already running.
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
    // Don't close the browser — that propagates a CDP disconnect that the
    // manager's lifecycle tracking interprets as a Quark death, triggering
    // an unnecessary restart cycle. Drop our reference and let the main loop
    // retry; Quark stays running.
    log.warn(
      "No BrowserContext found yet; releasing connection and retrying",
    );
    setBrowser(null);
    return;
  }

  const pages = context.pages();

  if (pages.length === 0) {
    // Same reasoning as the no-context branch: do NOT close the browser.
    // Pages may simply not have rendered yet during cold-start. The next
    // reconnect cycle will pick them up. (Logging the empty for-loop body
    // here was a no-op anyway.)
    log.warn("No pages found yet; releasing connection and retrying");
    setBrowser(null);
    return;
  }

  // get DevTools URLs if needed
  // deno-lint-ignore prefer-const
  let devtoolsUrls: Map<string, string> = new Map();

  try {
    const cdpBase = CDP_URL.replace(/\/$/, "");
    const list: Array<{ url: string; devtoolsFrontendUrl: string }> =
      await fetch(`${cdpBase}/json/list`).then((r) => r.json());
    for (const t of list) {
      devtoolsUrls.set(t.url, t.devtoolsFrontendUrl);
    }
  } catch (e) {
    log.warn("Failed to fetch DevTools URLs, DevTools will not be opened", e);
  }

  for (const page of pages) {
    const title = await page.title();
    log.debug(`attached to page: [${title}] ${page.url()}`);

    const frontendUrl = devtoolsUrls.get(page.url());
    if (frontendUrl) {
      const fullUrl = `${
        CDP_URL.replace(/\/$/, "").replace(/\/json.*$/, "")
      }${frontendUrl}`;
      log.debug(`DevTools URL: ${fullUrl}`);
    } else {
      log.warn(
        `No DevTools URL found for page ${page.url()}, skipping DevTools`,
      );
    }

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
