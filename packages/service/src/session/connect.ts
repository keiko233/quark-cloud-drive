import { chromium, type Browser, type Page } from "playwright";
import { CDP_URL, log } from "@quark/config";
import {
  clearBrowser,
  getBrowser,
  QUARK_HOME_PAGE_URL,
  QUARK_LOGIN_PAGE_URL,
  readLoginStateRaw,
  setBrowser,
} from "@quark/drive";

let pending: Promise<void> | undefined;

export function hasAttachedSession(): boolean {
  try {
    return getBrowser().isConnected() && readLoginStateRaw() !== "unknown";
  } catch {
    return false;
  }
}

/** Attach once to the running client, regardless of which adapter asked. */
export function connect(): Promise<void> {
  if (pending) return pending;
  pending = attach().finally(() => { pending = undefined; });
  return pending;
}

async function attach(): Promise<void> {
  let browser: Browser | undefined;
  try {
    const existing = getBrowser();
    if (existing.isConnected()) browser = existing;
  } catch {
    // No connection has been installed yet.
  }
  if (browser) {
    if (readLoginStateRaw() === "unknown") await waitForRenderer(browser);
    return;
  }

  const attached = await chromium.connectOverCDP(CDP_URL, { timeout: 5_000, noDefaults: true });
  try {
    await waitForRenderer(attached);
    if (!attached.isConnected()) throw new Error("Quark disconnected during startup");
    attached.once("disconnected", () => {
      clearBrowser(attached);
      log.debug("Quark CDP disconnected");
    });
    setBrowser(attached);
    const trackPage = (page: Page) => {
      page.on("crash", () => {
        if (![QUARK_HOME_PAGE_URL, QUARK_LOGIN_PAGE_URL].some((url) => page.url().includes(url))) return;
        log.warn("Quark renderer crashed; dropping the stale attachment");
        clearBrowser(attached);
        void attached.close().catch(() => {});
      });
    };
    for (const context of attached.contexts()) {
      for (const page of context.pages()) trackPage(page);
      context.on("page", trackPage);
    }
  } catch (error) {
    await attached.close().catch(() => {});
    throw error;
  }
}

/** Home readiness is the native API, not window pixels or DOM content. */
export async function waitForRenderer(
  browser: Browser,
  { timeoutMs = 30_000, pollMs = 500 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (browser.isConnected() && Date.now() < deadline) {
    const pages = browser.contexts()[0]?.pages() ?? [];
    if (pages.some((page) => page.url().includes(QUARK_LOGIN_PAGE_URL))) return;

    const home = pages.find((page) => page.url().includes(QUARK_HOME_PAGE_URL));
    if (home) {
      try {
        const ready = await bounded(home.evaluate(() => {
          const store = (globalThis as typeof globalThis & {
            store?: { dispatch?: { downloadTask?: { create?: unknown } }; getState?: unknown };
          }).store;
          return typeof store?.getState === "function" &&
            typeof store.dispatch?.downloadTask?.create === "function";
        }), Math.min(2_000, Math.max(1, deadline - Date.now())));
        if (ready) return;
      } catch {
        // The document may be navigating or the renderer may still be booting.
      }
    }
    await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Quark login window or native download API did not become ready");
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("native API readiness probe timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
