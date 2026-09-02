import {
  type RuntimeConfig,
  type RuntimeConfigPatch,
  RuntimeConfigSchema,
} from "@quark/contract/schemas";
import {
  IDLE_CHECK_INTERVAL_MS,
  IDLE_MINIMIZE_AFTER_MS,
  IDLE_STOP_AFTER_MS,
} from "../env.ts";
import { log } from "../logger.ts";
import { kvStore } from "./kv.ts";

const CONFIG_KEY = "runtime.config";

// The first run is backwards compatible with the old environment variables.
// Once written, the KV value is authoritative and can be changed at runtime.
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  enabled: true,
  checkIntervalMs: IDLE_CHECK_INTERVAL_MS,
  downloadProbeIntervalMs: 5 * 60_000,
  activityWindowMs: 30_000,
  minimizeAfterMs: IDLE_MINIMIZE_AFTER_MS,
  stopAfterMs: IDLE_STOP_AFTER_MS,
  stopWhenLoggedOut: false,
  stopWhenUnhealthy: false,
  requireLoginFor: [
    "userInfo",
    "listFile",
    "downloadStatus",
    "downloadFile",
    "updateDownloadStatus",
    "importShareLink",
  ],
};

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const stored = await kvStore.getSetting<unknown>(CONFIG_KEY);
  const parsed = RuntimeConfigSchema.safeParse(stored);
  if (parsed.success) return parsed.data;

  await kvStore.setSetting(CONFIG_KEY, DEFAULT_RUNTIME_CONFIG);
  if (stored !== null) {
    log.warn("invalid persisted runtime config; reset to defaults");
  }
  return DEFAULT_RUNTIME_CONFIG;
}

export async function updateRuntimeConfig(
  patch: RuntimeConfigPatch,
): Promise<RuntimeConfig> {
  const current = await getRuntimeConfig();
  const next = RuntimeConfigSchema.parse({ ...current, ...patch });
  await kvStore.setSetting(CONFIG_KEY, next);
  log.info(`runtime config updated: ${JSON.stringify(next)}`);
  return next;
}
