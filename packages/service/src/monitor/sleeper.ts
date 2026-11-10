// Adaptive idle monitor. Cheap process/login checks run at the configured
// interval; the cloud task probe (an API read) has its own slower cadence.

import type {
  LoginState,
  ProcessState,
  RuntimeConfig,
  RuntimeStatus,
  ServerStatus,
} from "@quark/contract/schemas";
import { EventPublisher } from "@orpc/server";
import { log } from "@quark/config";
import { processManager } from "@quark/manager";
import {
  fetchQuarkTaskCounts,
  getOperationQueue,
  getQuarkTransport,
  getRuntimeConfig,
  hasActiveDownloads,
  readLoginStateRaw,
} from "@quark/drive";
import { hasDriveRequests } from "../guard.ts";
import { makeRuntimeStatus, saveRuntimeStatus } from "./status.ts";

export interface IdleConfig {
  minimizeAfterMs: number;
  stopAfterMs: number;
  checkIntervalMs: number;
  activityWindowMs: number;
  taskProbeIntervalMs?: number;
  enabled?: boolean;
  stopWhenLoggedOut?: boolean;
  stopWhenUnhealthy?: boolean;
}

export type IdleDecision =
  | { action: "none" }
  | { action: "minimize"; reason: string }
  | { action: "stop"; reason: string }
  | { action: "restore"; reason: string };

interface SleeperEvents {
  decision: IdleDecision & { at: number };
  status: { status: RuntimeStatus };
}

/** Pure idle decision function, retained as a small unit-testable policy. */
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
    (state === "running_minimized" || state === "running_visible") && config.stopAfterMs > 0 &&
    idleForMs >= config.stopAfterMs
  ) {
    return { action: "stop", reason: `idle ${idleForMs}ms ≥ stopAfterMs` };
  }
  if (
    state === "running_visible" && config.minimizeAfterMs > 0 &&
    idleForMs >= config.minimizeAfterMs
  ) {
    return {
      action: "minimize",
      reason: `idle ${idleForMs}ms ≥ minimizeAfterMs`,
    };
  }
  return { action: "none" };
}

type ProbeResult = {
  busy: boolean;
  idleForMs: number;
  state: ProcessState;
  login: LoginState;
  process: ServerStatus;
};

export class Sleeper {
  readonly events = new EventPublisher<SleeperEvents>();

  private idleStart: number | null = null;
  private running = false;
  private latest: RuntimeStatus | null = null;
  private lastTaskProbeAt: number | null = null;
  private runningTasks: number | null = null;
  private tasksCheckedAt: number | null = null;
  private lastDecision: string | null = null;
  private lastReason: string | null = null;
  private lastError: string | null = null;
  private loginGraceUntil = 0;
  private fixedConfig: IdleConfig | null;

  constructor(config?: IdleConfig) {
    this.fixedConfig = config ?? null;
  }

  status(): RuntimeStatus | null {
    return this.latest;
  }

  private async config(): Promise<RuntimeConfig> {
    if (!this.fixedConfig) return await getRuntimeConfig();
    return {
      enabled: this.fixedConfig.enabled ?? true,
      checkIntervalMs: this.fixedConfig.checkIntervalMs,
      taskProbeIntervalMs: this.fixedConfig.taskProbeIntervalMs ?? 5 * 60_000,
      activityWindowMs: this.fixedConfig.activityWindowMs,
      minimizeAfterMs: this.fixedConfig.minimizeAfterMs,
      stopAfterMs: this.fixedConfig.stopAfterMs,
      stopWhenLoggedOut: this.fixedConfig.stopWhenLoggedOut ?? false,
      stopWhenUnhealthy: this.fixedConfig.stopWhenUnhealthy ?? false,
    };
  }

  private async probe(config: RuntimeConfig): Promise<ProbeResult> {
    const result = await processManager.status().then(
      (process) => ({ process, error: null as string | null }),
      (error) => ({
        process: null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    const process = result.process ?? {
      state: "stopped" as const,
      pid: null,
      alive: false,
      startedAt: null,
      cdpActivityAt: null,
      counts: { start: 0, stop: 0, minimize: 0 },
    };
    this.lastError = result.error;

    // Page URL inspection is local and cheap. It is deliberately before any
    // transport-panel operation, and a login renderer is sufficient to mark
    // the session logged out.
    const login = process.state === "stopped" || process.state === "starting"
      ? "unknown"
      : readLoginStateRaw();
    const now = Date.now();
    const recentActivity = process.cdpActivityAt !== null &&
      now - process.cdpActivityAt < config.activityWindowMs;

    let localDownloadsActive = false;
    if (login === "logged_in") {
      if (this.lastTaskProbeAt === null ||
          now - this.lastTaskProbeAt >= config.taskProbeIntervalMs) {
        this.lastTaskProbeAt = now;
        try {
          const { counts } = await fetchQuarkTaskCounts(getQuarkTransport());
          this.runningTasks = counts.todo + counts.running;
          this.tasksCheckedAt = Date.now();
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
        }
      }
      try {
        localDownloadsActive = await hasActiveDownloads();
      } catch (error) {
        // A broken local queue probe cannot tell us that it is safe to stop.
        localDownloadsActive = true;
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    } else {
      this.runningTasks = this.tasksCheckedAt = this.lastTaskProbeAt = null;
    }

    const busy = process.state === "starting" || recentActivity ||
      hasDriveRequests() || getOperationQueue().status().total > 0 ||
      localDownloadsActive || (this.runningTasks ?? 0) > 0;
    if (busy) this.idleStart = now;
    else if (this.idleStart === null) this.idleStart = now;
    const idleForMs = busy ? 0 : now - this.idleStart;
    return { busy, idleForMs, state: process.state, login, process };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.idleStart = Date.now();
    log.info("adaptive sleeper started");
    while (this.running) {
      const config = await this.config();
      await new Promise((resolve) =>
        setTimeout(resolve, config.checkIntervalMs)
      );
      try {
        await this.tick(await this.config());
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        log.warn(`sleeper tick failed: ${this.lastError}`);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  holdForLogin(): void {
    this.loginGraceUntil = Date.now() + 2 * 60_000;
  }

  /** Explicit manager start/QR access clears an intentional stop marker. */
  clearDecision(): void {
    this.lastDecision = null;
    this.lastReason = null;
    if (this.latest) {
      this.latest = {
        ...this.latest,
        monitor: {
          ...this.latest.monitor,
          lastDecision: null,
          lastReason: null,
        },
      };
    }
  }

  private async tick(config: RuntimeConfig): Promise<void> {
    const checkedAt = Date.now();
    const probe = await this.probe(config);
    const status = makeRuntimeStatus({
      process: probe.process,
      login: probe.login,
      runningTasks: this.runningTasks,
      tasksCheckedAt: this.tasksCheckedAt,
      queue: getOperationQueue().status(),
      idleForMs: probe.idleForMs,
      config,
      lastCheckAt: checkedAt,
      nextCheckAt: checkedAt + config.checkIntervalMs,
      lastDecision: this.lastDecision,
      lastReason: this.lastReason,
      lastError: this.lastError,
    });
    this.latest = status;
    await saveRuntimeStatus(status).catch((error) =>
      log.warn(`failed to persist runtime status: ${error}`)
    );
    this.events.publish("status", { status });

    if (!config.enabled || probe.state === "starting") return;
    if (probe.login !== "logged_in" && Date.now() < this.loginGraceUntil) return;

    let decision: IdleDecision = { action: "none" };
    if (config.stopWhenLoggedOut && probe.login === "logged_out") {
      decision = { action: "stop", reason: "login renderer detected" };
    } else if (
      config.stopWhenUnhealthy && probe.process.pid !== null &&
      !probe.process.alive
    ) {
      decision = { action: "stop", reason: "process is unhealthy" };
    } else if (probe.state === "stopped") {
      return;
    } else {
      decision = decideIdleAction(
        probe.state,
        probe.busy,
        probe.idleForMs,
        config,
      );
    }
    if (decision.action === "none") return;
    if (decision.action !== "restore" && (hasDriveRequests() || getOperationQueue().status().total > 0)) return;

    this.lastDecision = decision.action;
    this.lastReason = decision.reason;
    const markedStatus: RuntimeStatus = {
      ...status,
      monitor: {
        ...status.monitor,
        lastDecision: this.lastDecision,
        lastReason: this.lastReason,
      },
    };
    this.latest = markedStatus;
    await saveRuntimeStatus(markedStatus).catch((error) =>
      log.warn(`failed to persist monitor decision: ${error}`)
    );
    this.events.publish("status", { status: markedStatus });
    log.info(`sleeper: ${decision.action} (${decision.reason})`);
    this.events.publish("decision", { ...decision, at: Date.now() });
    // Requests may have arrived while persisting the status snapshot.
    if (decision.action !== "restore" && (hasDriveRequests() || getOperationQueue().status().total > 0)) return;
    if (decision.action === "minimize") await processManager.minimize();
    if (decision.action === "stop") await processManager.stop();
    if (decision.action === "restore") await processManager.restore();
  }
}
