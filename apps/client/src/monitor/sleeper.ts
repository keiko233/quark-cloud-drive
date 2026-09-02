// Adaptive idle monitor. Cheap process/login checks run at the configured
// interval; the expensive transport-panel check has its own slower cadence.

import type {
  LoginState,
  ProcessState,
  RuntimeConfig,
  RuntimeStatus,
} from "@quark/contract/schemas";
import { EventPublisher } from "@orpc/server";
import { log } from "../logger.ts";
import { serverClient } from "../server-client/index.ts";
import { getOperationQueue } from "../browser/context.ts";
import { readLoginStateRaw } from "../actions/login-status.ts";
import { getRuntimeConfig } from "../store/config.ts";
import { makeRuntimeStatus, saveRuntimeStatus } from "./status.ts";

export interface IdleConfig {
  minimizeAfterMs: number;
  stopAfterMs: number;
  checkIntervalMs: number;
  activityWindowMs: number;
  downloadProbeIntervalMs?: number;
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
    state === "running_minimized" && config.stopAfterMs > 0 &&
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
  process: Awaited<ReturnType<typeof serverClient.status>>;
};

export class Sleeper {
  readonly events = new EventPublisher<SleeperEvents>();

  private idleStart: number | null = null;
  private running = false;
  private latest: RuntimeStatus | null = null;
  private lastDownloadProbeAt: number | null = null;
  private runningDownloads: number | null = null;
  private downloadsCheckedAt: number | null = null;
  private lastDecision: string | null = null;
  private lastReason: string | null = null;
  private lastError: string | null = null;
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
      downloadProbeIntervalMs: this.fixedConfig.downloadProbeIntervalMs ??
        5 * 60_000,
      activityWindowMs: this.fixedConfig.activityWindowMs,
      minimizeAfterMs: this.fixedConfig.minimizeAfterMs,
      stopAfterMs: this.fixedConfig.stopAfterMs,
      stopWhenLoggedOut: this.fixedConfig.stopWhenLoggedOut ?? false,
      stopWhenUnhealthy: this.fixedConfig.stopWhenUnhealthy ?? false,
      requireLoginFor: [
        "userInfo",
        "listFile",
        "downloadStatus",
        "downloadFile",
        "updateDownloadStatus",
        "importShareLink",
      ],
    };
  }

  private async probe(config: RuntimeConfig): Promise<ProbeResult> {
    const result = await serverClient.status().then(
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
    const cdpActive = process.cdpActivityAt !== null &&
      now - process.cdpActivityAt < config.activityWindowMs;

    if (
      login === "logged_in" && process.state !== "stopped" &&
      process.state !== "starting" &&
      (this.lastDownloadProbeAt === null ||
        now - this.lastDownloadProbeAt >= config.downloadProbeIntervalMs)
    ) {
      this.lastDownloadProbeAt = now;
      try {
        const { readRunningDownloadCountRaw } = await import(
          "../actions/download-status.ts"
        );
        const count = await getOperationQueue().run(
          "downloadStatusProbe",
          { key: "monitor:downloadStatus", priority: 10 },
          async () => await readRunningDownloadCountRaw(),
        );
        this.runningDownloads = count;
        this.downloadsCheckedAt = Date.now();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    const busy = process.state === "starting" || cdpActive ||
      (this.runningDownloads !== null && this.runningDownloads > 0);
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
      runningDownloads: this.runningDownloads,
      downloadsCheckedAt: this.downloadsCheckedAt,
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
    if (decision.action === "minimize") await serverClient.minimize();
    if (decision.action === "stop") await serverClient.stop();
    if (decision.action === "restore") await serverClient.restore();
  }
}
