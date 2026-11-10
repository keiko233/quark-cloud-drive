import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { test } from "bun:test";
import { RuntimeConfigSchema } from "@quark/contract/schemas";
import { DEFAULT_RUNTIME_CONFIG } from "./config.ts";

test("old guard lists do not reset other persisted runtime settings", () => {
  const previous = {
    ...DEFAULT_RUNTIME_CONFIG,
    stopAfterMs: 123_000,
    requireLoginFor: ["downloadFile", "importShareLink"],
  };
  const { requireLoginFor, ...expected } = previous;
  assertEquals(RuntimeConfigSchema.parse(previous), expected);
});
