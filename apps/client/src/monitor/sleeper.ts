// Idle/sleep policy — owned by the client. Decides when to minimize the Quark
// window and when to stop the process, based on "is anything happening" (a
// live download task or recent CDP activity) rather than the server's old CPU
// threshold heuristic.

import type { ProcessState } from "@quark/contract/schemas";
import { EventPublisher } from "@orpc/server";
import { log } from "../logger.ts";
import { serverClient } from "../server-client/index.ts";
import { getOperationQueue } from "../browser/context.ts";

export interface IdleConfig {
  minimizeAfterMs: number;
  stopAfterMs: number;
  checkIntervalMs: number;
  activityWindowMs: number;
}

/** What the sleeper should do on this tick. */
export type IdleDecision =
  | { action: "none" }
  | { action: "minimize"; reason: string }
  | { action: "stop"; reason: string }
  | { action: "restore"; reason: string };

interface SleeperEvents {
  decision: IdleDecision & { at: number };
}

/**
 * Pure decision function — testable without any browser or server.
 *
 * `state` is the last-known process state, `busy` is true when there is a
 * download task running or recent CDP activity, and `idleForMs` is how long
 * the client has observed no activity.
 */
export function decideIdleAction(
  state: ProcessState,
  busy: boolean,
  idleForMs: number,
  config: Pick<IdleConfig, "minimizeAfterMs" | "stopAfterMs">,
): IdleDecision {
  if (busy) {
    if (state === "running_minimized") {
      return { action: "restore", reason: "activity while minimized" };
    }
    return { action: "none" };
  }

  if (
    state === "running_minimized" &&
    config.stopAfterMs > 0 &&
    idleForMs >= config.stopAfterMs
  ) {
    return { action: "stop", reason: `idle ${idleForMs}ms ≥ stopAfterMs` };
  }

  if (
    state === "running_visible" &&
    config.minimizeAfterMs > 0 &&
    idleForMs >= config.minimizeAfterMs
  ) {
    return {
      action: "minimize",
      reason: `idle ${idleForMs}ms ≥ minimizeAfterMs`,
    };
  }

  return { action: "none" };
}

export class Sleeper {
  readonly events = new EventPublisher<SleeperEvents>();

  private idleStart: number | null = null;
  private running = false;

  constructor(private config: IdleConfig) {}

  /** Busy detector — overridable for tests. Returns `{busy, idleForMs}`. */
  protected async probe(): Promise<{
    busy: boolean;
    idleForMs: number;
    state: ProcessState;
  }> {
    const [status, downloadStatus] = await Promise.allSettled([
      serverClient.status(),
      // The probe also drives the shared Quark window. It must be serialized
      // with user operations, otherwise it can switch list-file to Transport
      // while a virtual list is being collected.
      getOperationQueue().run(
        "downloadStatusProbe",
        { key: "monitor:downloadStatus", priority: 10 },
        async () => {
          const { readDownloadStatusRaw, readRunningDownloadCountRaw } =
            await import(
              "../actions/download-status.ts"
            );
          const count = await readRunningDownloadCountRaw();
          if (count !== null) return count;
          return await readDownloadStatusRaw("running", { restorePage: true });
        },
      ),
    ]);

    const hasRunningTask = downloadStatus.status === "fulfilled" &&
      (typeof downloadStatus.value === "number"
        ? downloadStatus.value > 0
        : downloadStatus.value.tasks.length > 0);

    const state = status.status === "fulfilled"
      ? status.value.state
      : "stopped";
    const cdpActive = status.status === "fulfilled" &&
      status.value.cdpActivityAt !== null &&
      Date.now() - status.value.cdpActivityAt < this.config.activityWindowMs;

    const busy = hasRunningTask || cdpActive;

    let idleForMs = 0;
    if (busy) {
      this.idleStart = Date.now();
    } else {
      if (this.idleStart === null) this.idleStart = Date.now();
      idleForMs = Date.now() - this.idleStart;
    }

    return { busy, idleForMs, state };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.idleStart = Date.now();
    log.info(
      `sleeper started (minimize=${this.config.minimizeAfterMs}ms, ` +
        `stop=${this.config.stopAfterMs}ms)`,
    );
    while (this.running) {
      await new Promise((r) => setTimeout(r, this.config.checkIntervalMs));
      try {
        await this.tick();
      } catch (e) {
        log.warn(`sleeper tick failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async tick(): Promise<void> {
    const { busy, idleForMs, state } = await this.probe();
    const decision = decideIdleAction(state, busy, idleForMs, this.config);
    if (decision.action === "none") return;

    log.info(
      `sleeper: ${decision.action} (${decision.reason}, state=${state})`,
    );
    this.events.publish("decision", { ...decision, at: Date.now() });

    switch (decision.action) {
      case "minimize":
        await serverClient.minimize();
        break;
      case "stop":
        await serverClient.stop();
        break;
      case "restore":
        await serverClient.restore();
        break;
    }
  }
}
