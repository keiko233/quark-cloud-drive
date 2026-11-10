import { strict as assert } from "node:assert";
import { test } from "bun:test";
import type { Browser } from "playwright";
import { QUARK_HOME_PAGE_URL, QUARK_LOGIN_PAGE_URL } from "@quark/drive";
import { waitForRenderer } from "./connect.ts";

function browserWith(url: string, evaluate: () => Promise<boolean>): Browser {
  return {
    isConnected: () => true,
    contexts: () => [{ pages: () => [{ url: () => url, evaluate }] }],
  } as unknown as Browser;
}

test("native API readiness does not depend on a screenshot", async () => {
  await waitForRenderer(browserWith(QUARK_HOME_PAGE_URL, async () => true), { timeoutMs: 50 });
});

test("a listening browser with no native download API is not ready", async () => {
  await assert.rejects(
    waitForRenderer(browserWith(QUARK_HOME_PAGE_URL, async () => false), { timeoutMs: 20, pollMs: 1 }),
    /native download API did not become ready/,
  );
});

test("a login window can be used before the download API is initialized", async () => {
  const browser = browserWith(QUARK_LOGIN_PAGE_URL, async () => {
    throw new Error("must not evaluate the login renderer");
  });
  await waitForRenderer(browser, { timeoutMs: 50 });
});
