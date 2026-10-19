import {
  type RuntimeConfig,
  type RuntimeConfigPatch,
  RuntimeConfigSchema,
} from "@quark/contract/schemas";
import {
  IDLE_CHECK_INTERVAL_MS,
  IDLE_MINIMIZE_AFTER_MS,
  IDLE_STOP_AFTER_MS,
} from "@quark/config";
import { log } from "@quark/config";
import { kvStore } from "./kv.ts";

const CONFIG_KEY = "runtime.config";

// The first run is backwards compatible with the old environment variables.
// Once written, the KV value is authoritative and can be changed at runtime.
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  enabled: true,
  checkIntervalMs: IDLE_CHECK_INTERVAL_MS,
  taskProbeIntervalMs: 5 * 60_000,
  activityWindowMs: 30_000,
  minimizeAfterMs: IDLE_MINIMIZE_AFTER_MS,
  stopAfterMs: IDLE_STOP_AFTER_MS,
  stopWhenLoggedOut: false,
  stopWhenUnhealthy: false,
  requireLoginFor: [
    "userInfo",
    "listFile",
    "fileInfo",
    "downloadFile",
    "startDownload",
    "downloadTask",
    "listTask",
    "updateTask",
    "importShareLink",
  ],
};

/**
 * Merge a stored config with the current defaults.
 *
 * `requireLoginFor` grows as operations are added, and a persisted config
 * would otherwise pin the older, shorter list — leaving newly added mutating
 * operations unguarded. Unioning keeps the safe default without discarding a
 * user's own additions, and is logged so the change is visible.
 */
export function withCurrentGuardDefaults(config: RuntimeConfig): RuntimeConfig {
  const missing = DEFAULT_RUNTIME_CONFIG.requireLoginFor.filter(
    (operation) => !config.requireLoginFor.includes(operation),
  );
  if (missing.length === 0) return config;
  log.info(`runtime config: added default login guards ${missing.join(", ")}`);
  return {
    ...config,
    requireLoginFor: [...config.requireLoginFor, ...missing],
  };
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const stored = await kvStore.getSetting<unknown>(CONFIG_KEY);
  const parsed = RuntimeConfigSchema.safeParse(stored);
  if (parsed.success) return withCurrentGuardDefaults(parsed.data);

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
