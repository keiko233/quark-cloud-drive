import { assertEquals } from "@jsr/std__assert";
import { test } from "bun:test";
import { TtlCache } from "./cache.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("TtlCache returns value within TTL", () => {
  const cache = new TtlCache<string, number>(10_000);
  cache.set("a", 1);
  assertEquals(cache.get("a"), 1);
});

test("TtlCache expires entries after TTL", async () => {
  const cache = new TtlCache<string, number>(20);
  cache.set("a", 1);
  await sleep(40);
  assertEquals(cache.get("a"), undefined);
});

test("TtlCache has() respects expiry", async () => {
  const cache = new TtlCache<string, number>(20);
  cache.set("a", 1);
  assertEquals(cache.has("a"), true);
  await sleep(40);
  assertEquals(cache.has("a"), false);
});

test("TtlCache invalidateWhere deletes matching entries only", () => {
  const cache = new TtlCache<string, number>(10_000);
  cache.set("taskList:running", 1);
  cache.set("taskList:all", 2);
  cache.set("fileList:", 3);
  cache.invalidateWhere((k) => k.startsWith("taskList:"));
  assertEquals(cache.get("taskList:running"), undefined);
  assertEquals(cache.get("taskList:all"), undefined);
  assertEquals(cache.get("fileList:"), 3);
});

test("TtlCache delete removes a single key", () => {
  const cache = new TtlCache<string, number>(10_000);
  cache.set("a", 1);
  cache.delete("a");
  assertEquals(cache.get("a"), undefined);
});

test("TtlCache clear empties the store", () => {
  const cache = new TtlCache<string, number>(10_000);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.clear();
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), undefined);
});
