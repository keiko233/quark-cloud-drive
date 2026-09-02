import { assert, assertEquals, assertMatch } from "@std/assert";
import { chromium } from "playwright";

const enabled = Deno.env.get("QUARK_E2E") === "1";
const clientUrl = Deno.env.get("CLIENT_URL") ?? "http://127.0.0.1:3000";
const cdpUrl = Deno.env.get("CDP_URL") ?? "http://127.0.0.1:9223";

interface SseEvent {
  type?: string;
  message?: string;
  path?: string[];
  items?: unknown[];
}

function parseSseEvents(body: string): SseEvent[] {
  return body.split(/\n\s*\n/).flatMap((block) => {
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (!data) return [];
    try {
      return [JSON.parse(data) as SseEvent];
    } catch {
      return [];
    }
  });
}

Deno.test({
  name: "list-file restores 首页 and emits navigation/read events",
  ignore: !enabled,
  fn: async () => {
    const browser = await chromium.connectOverCDP(cdpUrl);
    try {
      const page = browser.contexts().flatMap((context) => context.pages())
        .find((candidate) => candidate.url().includes("renderer/index.html"));
      assert(page, "Quark main page was not found");

      const transport = page.locator(
        "div.user-divider > .cloud-navigation-badge",
      ).filter({ hasText: "传输" }).first();
      await transport.waitFor({ state: "visible", timeout: 10_000 });
      await transport.locator(".cloud-navigation-list").click();
      await page.waitForFunction(
        () => location.hash.startsWith("#/transport"),
        undefined,
        { timeout: 10_000 },
      );

      const response = await fetch(`${clientUrl}/list-file`);
      assertEquals(response.status, 200);
      const events = parseSseEvents(await response.text());
      const statuses = events.filter((event) => event.type === "status")
        .map((event) => event.message ?? "");

      assert(statuses.some((message) => message.includes("当前页面")));
      assert(statuses.includes("click 首页"));
      assert(statuses.includes("读取首页滚动列表"));

      const result = events.find((event) => Array.isArray(event.items));
      assert(result, "list-file did not emit a final result");
      assertEquals(result.path, []);
      assertMatch(page.url(), /#\/list/);
      assertEquals(
        await page.locator("#quark-cloud-drive-list-all-breadcrumb").count() >
          0,
        true,
      );
    } finally {
      // For a connectOverCDP browser Playwright's close() disconnects the
      // client connection; it does not terminate the externally owned Quark
      // process.
      await browser.close();
    }
  },
});
