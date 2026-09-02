// Wake/sleep decisions for Quark. The client owns idle policy — the server
// only executes start/stop/minimize/restore.

import { CDP_READY_POLL_MS, CDP_READY_TIMEOUT_MS, CDP_URL } from "../env.ts";
import { serverClient } from "../server-client/index.ts";
import { getRuntimeConfig } from "../store/config.ts";
import { getSavedRuntimeStatus } from "./status.ts";

/** One-shot CDP liveness check via the server's CDP proxy. */
export async function isCdpReachable(timeoutMs = 1500): Promise<boolean> {
  const probeUrl = `${CDP_URL.replace(/\/$/, "")}/json/version`;
  try {
    const resp = await fetch(probeUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await resp.body?.cancel();
    return resp.ok;
  } catch {
    return false;
  }
}

export async function waitForCdpReady(
  { timeoutMs = CDP_READY_TIMEOUT_MS, pollMs = CDP_READY_POLL_MS } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const probeUrl = `${CDP_URL.replace(/\/$/, "")}/json/version`;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(probeUrl);
      await resp.body?.cancel();
      if (resp.ok) return;
      lastErr = new Error(`CDP probe ${probeUrl} → HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `CDP not ready within ${timeoutMs}ms (${probeUrl}): ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

// Concurrency-safe wake: dedupe parallel callers onto one in-flight promise.
let pendingWake: Promise<void> | null = null;

/** True when the monitor intentionally stopped a logged-out instance. */
export async function isAutoWakeBlocked(): Promise<boolean> {
  const config = await getRuntimeConfig();
  if (!config.stopWhenLoggedOut) return false;
  const status = await getSavedRuntimeStatus();
  return status?.monitor.lastDecision === "stop" &&
    status.monitor.lastReason === "login renderer detected";
}

export function ensureQuarkAwake(
  options: { force?: boolean } = {},
): Promise<void> {
  if (pendingWake) return pendingWake;
  pendingWake = (async () => {
    try {
      if (!options.force && await isAutoWakeBlocked()) return;
      // Cheap path: if CDP already answers, nothing to do.
      if (await isCdpReachable()) return;
      // /start is idempotent: running → noop, minimized → restore, stopped →
      // launch. The server's /start returns once spawned; we wait for CDP.
      await serverClient.start();
      await waitForCdpReady();
    } finally {
      pendingWake = null;
    }
  })();
  return pendingWake;
}
