import { assertEquals } from "@jsr/std__assert";
import { test } from "bun:test";
import { RuntimeConfigSchema } from "@quark/contract/schemas";
import { DEFAULT_RUNTIME_CONFIG, withCurrentGuardDefaults } from "./config.ts";

test("withCurrentGuardDefaults adds new guards to a stale config", () => {
  const stale = RuntimeConfigSchema.parse({
    ...DEFAULT_RUNTIME_CONFIG,
    requireLoginFor: ["listFile", "downloadFile"],
  });
  const merged = withCurrentGuardDefaults(stale);
  assertEquals(merged.requireLoginFor.slice(0, 2), [
    "listFile",
    "downloadFile",
  ]);
  for (const operation of DEFAULT_RUNTIME_CONFIG.requireLoginFor) {
    assertEquals(merged.requireLoginFor.includes(operation), true);
  }
});

test("withCurrentGuardDefaults leaves a complete config alone", () => {
  const complete = RuntimeConfigSchema.parse({
    ...DEFAULT_RUNTIME_CONFIG,
    requireLoginFor: [...DEFAULT_RUNTIME_CONFIG.requireLoginFor].reverse(),
  });
  // Nothing to add, so the stored order and object identity are preserved.
  assertEquals(withCurrentGuardDefaults(complete), complete);
});
