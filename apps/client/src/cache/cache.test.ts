import { assertEquals } from "@std/assert";
import { TtlCache } from "./cache.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.test("TtlCache returns value within TTL", () => {
  const cache = new TtlCache<string, number>(10_000);
  cache.set("a", 1);
  assertEquals(cache.get("a"), 1);
});

Deno.test("TtlCache expires entries after TTL", async () => {
  const cache = new TtlCache<string, number>(20);
  cache.set("a", 1);
  await sleep(40);
  assertEquals(cache.get("a"), undefined);
});

Deno.test("TtlCache has() respects expiry", async () => {
  const cache = new TtlCache<string, number>(20);
  cache.set("a", 1);
  assertEquals(cache.has("a"), true);
  await sleep(40);
  assertEquals(cache.has("a"), false);
});

Deno.test("TtlCache invalidateWhere deletes matching entries only", () => {
  const cache = new TtlCache<string, number>(10_000);
  cache.set("downloadStatus:running", 1);
  cache.set("downloadStatus:all", 2);
  cache.set("fileList:", 3);
  cache.invalidateWhere((k) => k.startsWith("downloadStatus:"));
  assertEquals(cache.get("downloadStatus:running"), undefined);
  assertEquals(cache.get("downloadStatus:all"), undefined);
  assertEquals(cache.get("fileList:"), 3);
});

Deno.test("TtlCache delete removes a single key", () => {
  const cache = new TtlCache<string, number>(10_000);
  cache.set("a", 1);
  cache.delete("a");
  assertEquals(cache.get("a"), undefined);
});

Deno.test("TtlCache clear empties the store", () => {
  const cache = new TtlCache<string, number>(10_000);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.clear();
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), undefined);
});
