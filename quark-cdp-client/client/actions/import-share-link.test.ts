import { assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { setBrowser } from "../browser.ts";
import { importShareLink } from "./import-share-link.ts";
import { CDP_URL } from "../../libs/env.ts";

const TEST_SHARE_URL = "https://pan.quark.cn/s/36b5346c9082";

async function withBrowser<T>(fn: () => Promise<T>): Promise<T> {
  const browser = await chromium.connectOverCDP(CDP_URL);
  setBrowser(browser);
  try {
    return await fn();
  } finally {
    setBrowser(null);
  }
}

Deno.test({
  name: "importShareLink: returns the input URL on success",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withBrowser(async () => {
      const result = await importShareLink(TEST_SHARE_URL);

      const value = result.match({
        ok: (v) => v,
        err: (e) => {
          throw e;
        },
      });

      assertEquals(value.url, TEST_SHARE_URL);
      console.log(`[test] savedPath="${value.savedPath}"`);
    });
  },
});
