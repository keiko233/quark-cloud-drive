import { rejects } from "node:assert/strict";
import { test } from "bun:test";
import type { Page } from "playwright";
import { requestInRenderer } from "./renderer-http.ts";

test("an unresponsive renderer cannot hold the HTTP transport open indefinitely", async () => {
  const page = { evaluate: () => new Promise(() => {}) } as unknown as Page;
  await rejects(
    requestInRenderer(page, { url: "https://drive-pc.quark.cn/", timeoutMs: 1 }),
    /renderer did not answer before the request deadline/,
  );
});
