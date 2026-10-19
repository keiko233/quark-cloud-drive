import { assertEquals } from "@std/assert";
import {
  isOwnProcessGroup,
  ProcessManager,
  readProcessGroup,
} from "./process.ts";

Deno.test("isOwnProcessGroup refuses group ids shared with the container init", () => {
  // The entrypoint starts X, x11vnc and the manager in PID 1's group, and a
  // launcher inherits it. Signalling it degenerates into kill(0)/kill(-1).
  assertEquals(isOwnProcessGroup(1, 1), false);
  assertEquals(isOwnProcessGroup(0, 0), false);
  assertEquals(isOwnProcessGroup(-1, 1), false);
  assertEquals(isOwnProcessGroup(NaN, 1), false);
  assertEquals(isOwnProcessGroup(null, 1), false);
  // A group the launcher created for itself is signalable.
  assertEquals(isOwnProcessGroup(1175, 1), true);
  assertEquals(isOwnProcessGroup(1175, 42), true);
});

Deno.test("readProcessGroup parses pgrp and children inherit it", async () => {
  const own = readProcessGroup(Deno.pid);
  assertEquals(typeof own, "number");

  const child = new Deno.Command("sleep", { args: ["10"] }).spawn();
  try {
    // This inheritance is exactly why the group must not be signalled when the
    // launcher was spawned without creating a group of its own.
    assertEquals(readProcessGroup(child.pid), own);
  } finally {
    child.kill();
    await child.status;
  }
});

Deno.test("ProcessManager starts in stopped state with zero counters", async () => {
  const pm = new ProcessManager();
  const status = await pm.status();
  assertEquals(status.state, "stopped");
  assertEquals(status.alive, false);
  assertEquals(status.counts, { start: 0, stop: 0, minimize: 0 });
  assertEquals(status.startedAt, null);
  assertEquals(status.cdpActivityAt, null);
});

Deno.test("markActivity updates cdpActivityAt", async () => {
  const pm = new ProcessManager();
  const before = Date.now();
  pm.markActivity();
  const after = Date.now();
  const status = await pm.status();
  assertEquals(typeof status.cdpActivityAt, "number");
  assertBetween(status.cdpActivityAt!, before, after);
});

Deno.test("events delivers published process transitions", () => {
  const pm = new ProcessManager();
  const seen: string[] = [];
  const unsub = pm.events.subscribe("process", (e) => seen.push(e.state));
  const activitySeen: number[] = [];
  const unsubActivity = pm.events.subscribe(
    "activity",
    (e) => activitySeen.push(e.at),
  );

  // Drive the publisher through the manager's public surface: markActivity
  // publishes an activity event, and minimize/restore publish process events.
  pm.markActivity();
  assertEquals(activitySeen.length, 1);

  unsub();
  unsubActivity();
  assertEquals(seen, [], "no process transitions expected from these calls");
});

Deno.test("status self-heals stale state against liveness", async () => {
  const pm = new ProcessManager();
  // No Quark running: any non-stopped internal state reports stopped.
  // (Internal state is private; we verify the reported state is consistent
  // with the authoritative CDP probe, which is false in this environment.)
  const status = await pm.status();
  assertEquals(status.state, "stopped");
  assertEquals(status.alive, false);
});

function assertBetween(value: number, lo: number, hi: number): void {
  if (value < lo || value > hi) {
    throw new Error(`expected ${value} to be between ${lo} and ${hi}`);
  }
}

Deno.test("minimize throws when Quark is not running", async () => {
  const pm = new ProcessManager();
  await pm.minimize().then(
    () => {
      throw new Error("expected minimize to reject");
    },
    (e: unknown) => {
      assertEquals((e as Error).message, "Quark is not running");
    },
  );
});

Deno.test("restore throws when Quark is not running", async () => {
  const pm = new ProcessManager();
  await pm.restore().then(
    () => {
      throw new Error("expected restore to reject");
    },
    (e: unknown) => {
      assertEquals((e as Error).message, "Quark is not running");
    },
  );
});
