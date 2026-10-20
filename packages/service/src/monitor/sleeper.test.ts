import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { test } from "bun:test";
import { decideIdleAction } from "./sleeper.ts";

const CONFIG = { minimizeAfterMs: 300_000, stopAfterMs: 1_800_000 };

test("busy with visible state → no action", () => {
  assertEquals(
    decideIdleAction("running_visible", true, 10_000, CONFIG),
    { action: "none" },
  );
});

test("busy with minimized state → restore", () => {
  assertEquals(
    decideIdleAction("running_minimized", true, 10_000, CONFIG),
    { action: "restore", reason: "activity while minimized" },
  );
});

test("idle below minimize threshold → no action", () => {
  assertEquals(
    decideIdleAction("running_visible", false, 299_000, CONFIG),
    { action: "none" },
  );
});

test("idle at/over minimize threshold → minimize", () => {
  const decision = decideIdleAction("running_visible", false, 300_000, CONFIG);
  assertEquals(decision.action, "minimize");
  if (decision.action === "minimize") {
    assertEquals(decision.reason.includes("minimizeAfterMs"), true);
  }
});

test("idle at/over stop threshold while minimized → stop", () => {
  const decision = decideIdleAction(
    "running_minimized",
    false,
    1_800_000,
    CONFIG,
  );
  assertEquals(decision.action, "stop");
});

test("stop threshold ignored when minimize disabled", () => {
  const cfg = { minimizeAfterMs: 0, stopAfterMs: 1_800_000 };
  assertEquals(
    decideIdleAction("running_visible", false, 300_000, cfg).action,
    "none",
  );
});

test("idle while stopped → no action", () => {
  assertEquals(decideIdleAction("stopped", false, 10_000, CONFIG), {
    action: "none",
  });
});

test("idle while stopped over stop threshold → no action", () => {
  assertEquals(decideIdleAction("stopped", false, 10_000_000, CONFIG), {
    action: "none",
  });
});
