// @quark/config — the single source of truth for runtime configuration.
//
// Every deployment knob the app reads is declared here, so there is exactly
// one place to look. Process env wins; a local `.env` fills the gaps -- the
// runtime loads it into `process.env` before this module is evaluated, so
// there is no dotenv layer of our own. Nothing in this module reads, copies,
// logs, or persists credentials.

import { statSync } from "node:fs";
import type { levellike } from "@jsr/libs__logger";

const env = process.env;

function envInt(name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isNaN(n) ? def : n;
}

function envBool(name: string, def: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

// ── API surface ─────────────────────────────────────────────────────────────

/** Public REST/MCP/VNC port. */
export const SERVER_PORT = envInt("SERVER_PORT", 3000);

/** Manager (process lifecycle) API port, served by this same process. */
export const QUARK_API_PORT = envInt("QUARK_API_PORT", 8080);

/**
 * How the service reaches the process manager.
 *
 * - `embedded` (default): one process owns it directly — no HTTP hop.
 * - `http`: a manager in another container/process; `MANAGER_URL` is used.
 */
export const MANAGER_MODE = (env["QUARK_MANAGER_MODE"] ?? "embedded")
  .trim()
  .toLowerCase();

/** Base URL of a remote manager, used when `MANAGER_MODE` is `http`. */
export const MANAGER_URL = env["QUARK_MANAGER_URL"] ??
  env["SERVER_URL"] ??
  `http://127.0.0.1:${QUARK_API_PORT}`;

// ── Quark renderer transport ────────────────────────────────────────────────

/** CDP proxy port — where the service attaches to the Quark renderer. */
export const CDP_URL = env["CDP_URL"] ?? "http://127.0.0.1:9223";

/** Raw VNC endpoint (x11vnc); the noVNC page proxies to it. */
export const VNC_URL = env["VNC_URL"] ?? "http://127.0.0.1:5900";
export const NOVNC_STATIC_DIR = env["NOVNC_STATIC_DIR"] ?? "/usr/share/novnc";

export const RECONNECT_INTERVAL_MS = envInt("RECONNECT_INTERVAL_MS", 5_000);
export const CDP_READY_TIMEOUT_MS = envInt("CDP_READY_TIMEOUT_MS", 30_000);
export const CDP_READY_POLL_MS = envInt("CDP_READY_POLL_MS", 500);

// ── Wine/Electron process manager ───────────────────────────────────────────

/** Quark's own CDP port (inside the Wine prefix); the proxy fronts it. */
export const QUARK_CDP_PORT = envInt("QUARK_CDP_PORT", 9222);
export const CDP_PROXY_PORT = envInt("CDP_PROXY_PORT", 9223);
export const CDP_PROXY_BIND = env["CDP_PROXY_BIND"] ?? "0.0.0.0";
export const QUARK_AUTOSTART = envBool("QUARK_AUTOSTART", true);

export const WINE_USER = env["WINE_USER"] ?? "wineuser";
export const WINE_BIN = env["WINE_BIN"] ?? "/opt/deepin-wine8-stable/bin/wine";
export const WINESERVER_BIN = env["WINESERVER_BIN"] ??
  "/opt/deepin-wine8-stable/bin/wineserver";

/**
 * Launch script resolution: an explicit LAUNCH_SCRIPT wins; otherwise the
 * first existing candidate is used so bare dev runs find the repo's
 * `app/scripts/launch-quark.sh` (the image installs it at
 * /usr/local/bin/launch-quark.sh).
 */
function resolveLaunchScript(): string {
  const override = env["LAUNCH_SCRIPT"];
  if (override) return override;
  for (
    const candidate of [
      "/usr/local/bin/launch-quark.sh",
      "./scripts/launch-quark.sh",
      "app/scripts/launch-quark.sh",
      "/opt/quark-app/app/scripts/launch-quark.sh",
    ]
  ) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not present — try the next candidate
    }
  }
  return "/usr/local/bin/launch-quark.sh";
}

export const LAUNCH_SCRIPT = resolveLaunchScript();

export const QUARK_WINDOW_TITLE = env["QUARK_WINDOW_TITLE"] ?? "夸克网盘";
export const QUARK_PROCESS_PATTERNS = (env["QUARK_PROCESS_PATTERNS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Idle policy (owned by the service, executed by the manager) ─────────────

export const IDLE_MINIMIZE_AFTER_MS = envInt(
  "CLIENT_IDLE_MINIMIZE_AFTER_MS",
  300_000,
);
export const IDLE_STOP_AFTER_MS = envInt(
  "CLIENT_IDLE_STOP_AFTER_MS",
  900_000,
);
export const IDLE_CHECK_INTERVAL_MS = envInt(
  "CLIENT_IDLE_CHECK_INTERVAL_MS",
  30_000,
);

// ── Operation queue ─────────────────────────────────────────────────────────

export const QUEUE_OPERATION_TIMEOUT_MS = envInt(
  "QUEUE_OPERATION_TIMEOUT_MS",
  60_000,
);
export const QUEUE_MAX_WAITING = envInt("QUEUE_MAX_WAITING", 100);

// ── Persistence ─────────────────────────────────────────────────────────────

/** KV store (task/download history + runtime settings) SQLite path. */
export const KV_PATH = env["QUARK_KV_PATH"] ??
  env["CLIENT_KV_PATH"] ??
  "./data/kv.sqlite3";

// ── Logging ─────────────────────────────────────────────────────────────────

export const LOG_LEVEL = (env["LOG_LEVEL"] ?? "info") as levellike;
