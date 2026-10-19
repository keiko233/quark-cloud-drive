import { assertEquals } from "@jsr/std__assert";
import { test } from "bun:test";
import { consumeAsyncIterableFinal, isAsyncIterable } from "./stream.ts";

test("consumeAsyncIterableFinal returns the generator's terminal value", async () => {
  const gen = (async function* () {
    yield { type: "status", message: "click 首页" };
    yield { type: "collecting", seen: 3, total: 0 };
    return { fid: "x", items: [{ fid: "y" }] };
  })();
  assertEquals(await consumeAsyncIterableFinal(gen), {
    fid: "x",
    items: [{ fid: "y" }],
  });
});

test("isAsyncIterable distinguishes generators from plain values", () => {
  assertEquals(isAsyncIterable(null), false);
  assertEquals(isAsyncIterable({}), false);
  assertEquals(isAsyncIterable([]), false);
  assertEquals(isAsyncIterable(async function* () {}()), true);
});
