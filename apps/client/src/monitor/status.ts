import type {
  LoginState,
  RuntimeConfig,
  RuntimeHealth,
  RuntimeStatus,
  ServerStatus,
} from "@quark/contract/schemas";
import { kvStore } from "../store/kv.ts";

const STATUS_KEY = "runtime.status";

export interface RuntimeStatusInput {
  process: ServerStatus;
  login: LoginState;
  runningDownloads: number | null;
  downloadsCheckedAt: number | null;
  queue: RuntimeStatus["queue"];
  idleForMs: number;
  config: RuntimeConfig;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  lastDecision: string | null;
  lastReason: string | null;
  lastError: string | null;
}

export function scoreRuntimeStatus(
  process: ServerStatus,
  login: LoginState,
  queue: RuntimeStatus["queue"],
): { health: RuntimeHealth; healthScore: number } {
  // A deliberately explainable score: process 50, authentication 30, queue
  // pressure 20. It describes readiness for API work, not host CPU usage.
  let score = process.state === "running_visible" ||
      process.state === "running_minimized"
    ? 50
    : process.state === "starting"
    ? 20
    : 0;
  score += login === "logged_in" ? 30 : login === "unknown" ? 15 : 0;
  score += queue.total === 0 ? 20 : queue.total < 10 ? 15 : 5;
  const health: RuntimeHealth = score >= 80
    ? "healthy"
    : score >= 45
    ? "degraded"
    : "unhealthy";
  return { health, healthScore: score };
}

export function makeRuntimeStatus(input: RuntimeStatusInput): RuntimeStatus {
  const { health, healthScore } = scoreRuntimeStatus(
    input.process,
    input.login,
    input.queue,
  );
  const blocked = input.login === "logged_out" &&
    input.config.requireLoginFor.length > 0;
  return {
    generatedAt: Date.now(),
    process: input.process,
    login: input.login,
    downloads: {
      running: input.runningDownloads,
      checkedAt: input.downloadsCheckedAt,
    },
    queue: input.queue,
    health,
    healthScore,
    idleForMs: input.idleForMs,
    monitor: {
      enabled: input.config.enabled,
      checkIntervalMs: input.config.checkIntervalMs,
      lastCheckAt: input.lastCheckAt,
      nextCheckAt: input.nextCheckAt,
      lastDecision: input.lastDecision,
      lastReason: input.lastReason,
    },
    guard: {
      blocked,
      reason: blocked ? "login required" : null,
    },
    lastError: input.lastError,
  };
}

export async function saveRuntimeStatus(status: RuntimeStatus): Promise<void> {
  await kvStore.setSetting(STATUS_KEY, status);
}

export async function getSavedRuntimeStatus(): Promise<RuntimeStatus | null> {
  const value = await kvStore.getSetting<unknown>(STATUS_KEY);
  return value as RuntimeStatus | null;
}

/** Clear the intentional logged-out stop marker after an explicit wake. */
export async function clearLoggedOutStopMarker(): Promise<void> {
  const status = await getSavedRuntimeStatus();
  if (!status || status.monitor.lastReason !== "login renderer detected") {
    return;
  }
  await saveRuntimeStatus({
    ...status,
    monitor: {
      ...status.monitor,
      lastDecision: null,
      lastReason: null,
    },
  });
}
