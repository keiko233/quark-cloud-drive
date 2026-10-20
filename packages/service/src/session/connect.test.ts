import { strict as assert } from "node:assert";
import { test } from "bun:test";
import type { Browser, Page } from "playwright";
import { waitForRenderer } from "./connect.ts";

function rendererWithPaintedSamples(samples: number): Browser {
  const page = {
    url: () => "uccd://../renderer/index.html",
    screenshot: async () => Buffer.from("mock-png"),
    evaluate: async (fn: Function) =>
      fn.toString().includes("querySelectorAll") ? true : samples,
  } as unknown as Page;
  return {
    isConnected: () => true,
    contexts: () => [{ pages: () => [page] }],
  } as unknown as Browser;
}

test("renderer readiness accepts a painted home page", async () => {
  await waitForRenderer(rendererWithPaintedSamples(194), {
    timeoutMs: 100,
    pollMs: 1,
  });
});

test("renderer readiness rejects a white home page even when CDP has a target", async () => {
  await assert.rejects(
    waitForRenderer(rendererWithPaintedSamples(0), {
      timeoutMs: 20,
      pollMs: 1,
    }),
    /screenshot is blank/,
  );
});
