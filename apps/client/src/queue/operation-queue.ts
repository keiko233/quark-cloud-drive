// OperationQueue — single-slot serialization over the one Quark window, with
// priority, key-based coalescing, timeout/cancellation, backpressure, and a
// streaming variant for long operations.
//
// Replaces the legacy p-queue + `activeBrowserOperationLabel` global.

import { EventPublisher } from "@orpc/server";
import type { BrowserQueueStatus } from "@quark/contract/schemas";
import { QUEUE_MAX_WAITING, QUEUE_OPERATION_TIMEOUT_MS } from "../env.ts";
import { log } from "../logger.ts";

export class OperationTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`operation "${label}" timed out after ${timeoutMs}ms`);
    this.name = "OperationTimeoutError";
  }
}

export class OperationCancelledError extends Error {
  constructor(label: string) {
    super(`operation "${label}" was cancelled`);
    this.name = "OperationCancelledError";
  }
}

export class QueueFullError extends Error {
  constructor(maxWaiting: number) {
    super(`operation queue is full (max ${maxWaiting} waiting)`);
    this.name = "QueueFullError";
  }
}

export interface EnqueueOptions {
  /** Coalescing key: a task with the same key reuses the in-flight promise. */
  key?: string;
  /** Lower = higher priority. Reads default 0, writes 1, diagnostics -1. */
  priority?: number;
  /** Per-operation timeout. Defaults to QUEUE_OPERATION_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Caller-supplied cancellation. */
  signal?: AbortSignal;
  /** Coalescing policy when `key` matches an in-flight task. Default "reuse". */
  coalesce?: "reuse" | "skip" | "none";
}

interface WaitingTask<T> {
  label: string;
  opts: EnqueueOptions;
  fn: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  priority: number;
  enqueuedAt: number;
  settled: boolean;
}

interface QueueEvents {
  change: { status: BrowserQueueStatus };
  operation: { key: string | undefined; phase: "started" | "done" | "error" };
}

// ── minimal async channel ────────────────────────────────────────────────────
// A single-producer/single-consumer message queue used to stream events out of
// a queue-serialized generator while it runs.

export class Channel<T> {
  private items: T[] = [];
  private pending: Array<{
    resolve: (value: T | null) => void;
  }> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.pending.shift();
    if (waiter) waiter.resolve(item);
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending) waiter.resolve(null);
    this.pending.length = 0;
  }

  recv(): Promise<T | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.pending.push({ resolve }));
  }
}

// ── OperationQueue ───────────────────────────────────────────────────────────

export class OperationQueue {
  readonly events = new EventPublisher<QueueEvents>();

  private running: { label: string; startedAt: number } | null = null;
  private waiters: WaitingTask<unknown>[] = [];
  private inFlightByKey = new Map<string, Promise<unknown>>();
  private maxWaiting: number;

  constructor(options: { maxWaiting?: number } = {}) {
    this.maxWaiting = options.maxWaiting ?? QUEUE_MAX_WAITING;
  }

  /** Run a plain (non-streaming) operation. */
  run<T>(
    label: string,
    opts: EnqueueOptions,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const existing = this.coalesce<T>(label, opts);
    if (existing) return existing;

    if (this.waiters.length >= this.maxWaiting) {
      throw new QueueFullError(this.maxWaiting);
    }

    const task: WaitingTask<T> = {
      label,
      opts,
      fn,
      resolve: () => {},
      reject: () => {},
      priority: opts.priority ?? 0,
      enqueuedAt: Date.now(),
      settled: false,
    };
    const promise = new Promise<T>((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });

    if (opts.key) {
      const tracked = promise.finally(() =>
        this.inFlightByKey.delete(opts.key!)
      );
      // Mark handled so a coalesced caller's rejection isn't an unhandled
      // rejection; the value still propagates to whoever awaits it.
      tracked.catch(() => {});
      this.inFlightByKey.set(opts.key, tracked);
    }

    this.waiters.push(task as WaitingTask<unknown>);
    log.trace(`queue enqueue: ${label} (waiting: ${this.waiters.length})`);
    this.publish();
    this.schedule();
    return promise;
  }

  /**
   * Run a streaming operation. `gen` is executed inside the queue slot; every
   * yield is forwarded to the returned iterator and the final value is
   * returned on completion.
   */
  runStreaming<TYield, TReturn>(
    label: string,
    opts: EnqueueOptions,
    gen: (signal: AbortSignal) => AsyncGenerator<TYield, TReturn>,
  ): Promise<AsyncGenerator<TYield, TReturn>> {
    const channel = new Channel<
      { done: false; value: TYield } | { done: true; value: TReturn }
    >();

    const taskPromise = this.run(label, opts, async (signal) => {
      try {
        const it = gen(signal);
        while (true) {
          const step = await it.next();
          if (step.done) {
            channel.push({ done: true, value: step.value });
            return step.value;
          }
          channel.push({ done: false, value: step.value });
        }
      } catch (err) {
        channel.push({ done: true, value: err as TReturn });
        throw err;
      } finally {
        channel.close();
      }
    });

    const relay = async function* (): AsyncGenerator<TYield, TReturn> {
      try {
        while (true) {
          const item = await channel.recv();
          if (item === null) {
            // channel closed without a terminal marker — surface the error
            await taskPromise;
            throw new Error("stream ended without a result");
          }
          if (item.done) return item.value;
          yield item.value;
        }
      } finally {
        channel.close();
      }
    };

    return Promise.resolve(relay());
  }

  status(): BrowserQueueStatus {
    const running = this.running !== null;
    return {
      running,
      current: this.running?.label ?? null,
      queued: this.waiters.length,
      total: this.waiters.length + (running ? 1 : 0),
    };
  }

  /** Cancel a waiting or running task by its coalescing key. */
  cancel(key: string): boolean {
    const idx = this.waiters.findIndex((t) => t.opts.key === key);
    if (idx !== -1) {
      const task = this.waiters[idx];
      this.waiters.splice(idx, 1);
      task.settled = true;
      task.reject(new OperationCancelledError(task.label));
      this.publish();
      return true;
    }
    return false;
  }

  private coalesce<T>(
    label: string,
    opts: EnqueueOptions,
  ): Promise<T> | null {
    if (!opts.key || opts.coalesce === "none") return null;
    const inFlight = this.inFlightByKey.get(opts.key);
    if (!inFlight) return null;
    if (opts.coalesce === "skip") {
      return Promise.reject(
        new OperationCancelledError(`${label} (coalesced-skip)`),
      );
    }
    log.trace(
      `queue coalesce: ${label} reuses in-flight op for key="${opts.key}"`,
    );
    return inFlight as Promise<T>;
  }

  private schedule(): void {
    if (this.running) return;
    if (this.waiters.length === 0) return;

    // Pick the highest-priority waiter (stable by enqueue order).
    let bestIdx = 0;
    for (let i = 1; i < this.waiters.length; i++) {
      if (this.waiters[i].priority < this.waiters[bestIdx].priority) {
        bestIdx = i;
      }
    }
    const task = this.waiters.splice(bestIdx, 1)[0];

    this.running = { label: task.label, startedAt: Date.now() };
    this.publish();
    log.trace(`queue start: ${task.label}`);
    this.events.publish("operation", {
      key: task.opts.key,
      phase: "started",
    });

    const timeoutMs = task.opts.timeoutMs ?? QUEUE_OPERATION_TIMEOUT_MS;
    let aborted = false;
    let abortError: unknown = null;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      abortError = task.opts.signal?.aborted
        ? new OperationCancelledError(task.label)
        : new OperationTimeoutError(task.label, timeoutMs);
      // Force-reject on timeout/cancel even if the fn ignores the signal.
      if (!task.settled) {
        task.settled = true;
        task.reject(abortError);
        this.events.publish("operation", {
          key: task.opts.key,
          phase: "error",
        });
      }
    };
    const combined = task.opts.signal
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), task.opts.signal])
      : AbortSignal.timeout(timeoutMs);
    combined.addEventListener("abort", onAbort);

    task.fn(combined)
      .then(
        (value) => {
          if (!task.settled) {
            task.settled = true;
            task.resolve(value);
            this.events.publish("operation", {
              key: task.opts.key,
              phase: "done",
            });
          }
        },
        (error) => {
          if (!task.settled) {
            task.settled = true;
            task.reject(aborted ? abortError : error);
            this.events.publish("operation", {
              key: task.opts.key,
              phase: "error",
            });
          }
        },
      )
      .finally(() => {
        combined.removeEventListener("abort", onAbort);
        this.running = null;
        this.publish();
        this.schedule();
      });
  }

  private publish(): void {
    this.events.publish("change", { status: this.status() });
  }
}
