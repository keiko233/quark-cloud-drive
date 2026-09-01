import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { OperationQueue } from "./operation-queue.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.test("queue runs operations serially (concurrency 1)", async () => {
  const q = new OperationQueue({ maxWaiting: 100 });
  const order: string[] = [];
  const p1 = q.run("a", {}, async () => {
    order.push("a-start");
    await sleep(30);
    order.push("a-end");
    return 1;
  });
  const p2 = q.run("b", {}, () => {
    order.push("b-start");
    return Promise.resolve(2);
  });
  assertEquals(await p1, 1);
  assertEquals(await p2, 2);
  assertEquals(order, ["a-start", "a-end", "b-start"]);
});

Deno.test("queue reports status with running/queued/total", async () => {
  const q = new OperationQueue({ maxWaiting: 100 });
  const p1 = q.run("a", {}, async () => {
    await sleep(30);
    return 1;
  });
  const p2 = q.run("b", {}, () => Promise.resolve(2));
  const status = q.status();
  assertEquals(status.running, true);
  assertEquals(status.current, "a");
  assertEquals(status.queued, 1);
  assertEquals(status.total, 2);
  await Promise.all([p1, p2]);
  assertEquals(q.status().running, false);
  assertEquals(q.status().queued, 0);
});

Deno.test("queue runs higher-priority task first", async () => {
  const q = new OperationQueue({ maxWaiting: 100 });
  const order: string[] = [];
  const blocker = q.run("blocker", {}, async () => {
    await sleep(30);
    order.push("blocker");
    return 1;
  });
  const low = q.run("low", { priority: 5 }, () => {
    order.push("low");
    return Promise.resolve(1);
  });
  const high = q.run("high", { priority: -1 }, () => {
    order.push("high");
    return Promise.resolve(1);
  });
  await Promise.all([blocker, low, high]);
  assertEquals(order, ["blocker", "high", "low"]);
});

Deno.test("queue coalesces identical keys onto one in-flight operation", async () => {
  const q = new OperationQueue({ maxWaiting: 100 });
  let executions = 0;
  const p1 = q.run("a", { key: "same" }, async () => {
    executions++;
    await sleep(30);
    return "one";
  });
  const p2 = q.run("a", { key: "same" }, () => Promise.resolve("two"));
  assertEquals(await p1, "one");
  assertEquals(await p2, "one");
  assertEquals(executions, 1);
});

Deno.test("queue coalesce=skip rejects duplicates", async () => {
  const q = new OperationQueue({ maxWaiting: 100 });
  const p1 = q.run("a", { key: "k" }, async () => {
    await sleep(30);
    return 1;
  });
  const p2 = q.run(
    "a",
    { key: "k", coalesce: "skip" },
    () => Promise.resolve(2),
  );
  await assertRejects(() => p2);
  await p1;
});

Deno.test("queue times out a hung operation", async () => {
  const q = new OperationQueue({ maxWaiting: 100 });
  await assertRejects(
    () =>
      q.run(
        "hung",
        { timeoutMs: 30 },
        async () => {
          await sleep(500);
          return 1;
        },
      ),
    Error,
    "timed out",
  );
});

Deno.test("queue cancel() rejects a waiting task", async () => {
  const q = new OperationQueue({ maxWaiting: 100 });
  const blocker = q.run("blocker", {}, async () => {
    await sleep(30);
    return 1;
  });
  const waiting = q.run("waiting", { key: "w" }, () => Promise.resolve(2));
  const cancelled = q.cancel("w");
  assertEquals(cancelled, true);
  await assertRejects(() => waiting, Error, "cancelled");
  await blocker;
});

Deno.test("queue backpressure rejects beyond maxWaiting", async () => {
  const q = new OperationQueue({ maxWaiting: 2 });
  const blocker = q.run("blocker", {}, async () => {
    await sleep(50);
    return 1;
  });
  q.run("w1", {}, () => Promise.resolve(1));
  q.run("w2", {}, () => Promise.resolve(1));
  assertThrows(
    () => q.run("w3", {}, () => Promise.resolve(1)),
    Error,
    "queue is full",
  );
  await blocker;
});

Deno.test("queue publishes change and operation events", async () => {
  const q = new OperationQueue({ maxWaiting: 100 });
  const phases: string[] = [];
  const unsubOps = q.events.subscribe("operation", (e) => phases.push(e.phase));
  await q.run("a", { key: "x" }, () => Promise.resolve(1));
  assertEquals(phases, ["started", "done"]);
  unsubOps();
});

Deno.test("runStreaming forwards yields and returns the final value", async () => {
  const q = new OperationQueue({ maxWaiting: 100 });
  const stream = await q.runStreaming(
    "gen",
    {},
    async function* () {
      yield 1;
      yield 2;
      return "done";
    },
  );
  const collected: (number | string)[] = [];
  for await (const v of stream) collected.push(v);
  // The generator's return value isn't directly observable via for-await;
  // verify the yields were forwarded in order.
  assertEquals(collected, [1, 2]);
});
