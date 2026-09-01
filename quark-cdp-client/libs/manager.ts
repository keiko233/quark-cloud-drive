// Manager — the quark-docker FastAPI control plane (process lifecycle, window
// minimize/restore, idle status). The low-level SDK in `manager-client/` is
// generated from the manager's OpenAPI spec by `deno task gen-manager-client`;
// this file:
//   - configures the SDK's baseUrl from env
//   - re-exports the verbose auto-generated names under friendlier aliases
//   - provides `ensureQuarkAwake()`: idempotent /start + wait for CDP to come
//     back online, with in-flight dedup so a request burst triggers a single
//     wake instead of N parallel ones
//
// Strong dependency: callers assume manager is reachable. If the manager is
// down we throw — the client cannot make progress anyway because the same
// manager hosts the CDP proxy Playwright connects to.
import {
  CDP_URL,
  QUARK_CDP_READY_POLL_MS,
  QUARK_CDP_READY_TIMEOUT_MS,
  QUARK_MANAGER_URL,
} from "./env.ts";
import { log } from "./logger.ts";
import { client as managerHttpClient } from "./manager-client/client.gen.ts";
import {
  getStatusStatusGet,
  healthzHealthzGet,
  postMinimizeMinimizePost,
  postRestartRestartPost,
  postRestoreRestorePost,
  postStartStartPost,
  postStopStopPost,
} from "./manager-client/sdk.gen.ts";

managerHttpClient.setConfig({ baseUrl: QUARK_MANAGER_URL });

// Friendly re-exports. The auto-generated names encode method+path twice
// because FastAPI's default operation_id is `<func>_<path>_<method>`; calling
// `manager.start()` reads better than `postStartStartPost()` at call sites.
export const manager = {
  healthz: healthzHealthzGet,
  status: getStatusStatusGet,
  start: postStartStartPost,
  stop: postStopStopPost,
  restart: postRestartRestartPost,
  minimize: postMinimizeMinimizePost,
  restore: postRestoreRestorePost,
};

// Concurrency-safe wake: dedupe parallel callers onto one in-flight promise so
// a request burst doesn't fire N /start calls. Reset on completion so the next
// idle-stop can be waked again.
let pendingWake: Promise<void> | null = null;

/** Ensure Quark is running with its CDP port reachable. Idempotent and safe
 * to call from every request. Throws if the manager or CDP doesn't come back
 * within `QUARK_CDP_READY_TIMEOUT_MS`.
 *
 * CDP-probe-first: a fast `/json/version` check avoids hitting the manager
 * when Quark is already responding. This matters because the manager's
 * lifecycle tracking is fragile under the spark runtime — the `start.exe`
 * launcher exits early so `proc.poll()` returns non-None, and the manager
 * then incorrectly believes Quark died and restarts it on every /start call.
 * Skipping /start when CDP works keeps that loop from spinning. */
export function ensureQuarkAwake(): Promise<void> {
  if (pendingWake) return pendingWake;
  pendingWake = (async () => {
    try {
      // Cheap path: if CDP already answers, nothing to do.
      if (await isCdpReachable()) return;

      // /start is idempotent: running → noop, minimized → restore, stopped →
      // launch. We don't branch on /status first because /start already does
      // the equivalent check internally and saves a round-trip.
      const { error } = await manager.start();
      if (error) {
        throw new Error(`manager /start failed: ${JSON.stringify(error)}`);
      }
      await waitForCdpReady();
    } finally {
      // Always clear so the next idle-stop can wake again. If we crashed,
      // the next request will retry from scratch.
      pendingWake = null;
    }
  })();
  return pendingWake;
}

/** One-shot CDP liveness check. Returns true if `/json/version` answers 200,
 * false on any error (HTTP non-2xx, network failure, timeout). Cheap enough
 * to run on every request as a wake-skip predicate. */
async function isCdpReachable(timeoutMs = 1500): Promise<boolean> {
  const probeUrl = `${CDP_URL.replace(/\/$/, "")}/json/version`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(probeUrl, { signal: ctrl.signal });
      await resp.body?.cancel();
      return resp.ok;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

/** Poll `${CDP_URL}/json/version` until Chromium answers 200 or we time out. */
export async function waitForCdpReady(
  { timeoutMs = QUARK_CDP_READY_TIMEOUT_MS, pollMs = QUARK_CDP_READY_POLL_MS } =
    {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const probeUrl = `${CDP_URL.replace(/\/$/, "")}/json/version`;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(probeUrl);
      // Consume the body so the connection can be reused and the proxy doesn't
      // hold a half-open socket while we sleep.
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

/** Block until the manager itself answers /healthz. Called at boot before we
 * start the connect loop or the HTTP server. */
export async function waitForManagerReady(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const { error } = await manager.healthz();
      if (!error) return;
      lastErr = error;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `manager at ${QUARK_MANAGER_URL} not reachable within ${timeoutMs}ms: ${
      lastErr instanceof Error ? lastErr.message : JSON.stringify(lastErr)
    }`,
  );
}

// Boot-time visibility into the configured endpoints.
log.debug(`Manager configured: ${QUARK_MANAGER_URL}`);
