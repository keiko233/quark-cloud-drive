import { load } from "@std/dotenv";
import type { levellike } from "@libs/logger";

// Process env wins; .env fills the gaps.
const env = { ...(await load({ export: false })), ...Deno.env.toObject() };

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

export const QUARK_API_PORT = envInt("QUARK_API_PORT", 8080);
export const QUARK_CDP_PORT = envInt("QUARK_CDP_PORT", 9222);
export const CDP_PROXY_PORT = envInt("CDP_PROXY_PORT", 9223);
export const QUARK_AUTOSTART = envBool("QUARK_AUTOSTART", true);

export const CDP_PROXY_BIND = env["CDP_PROXY_BIND"] ?? "0.0.0.0";

export const WINE_USER = env["WINE_USER"] ?? "wineuser";
export const WINE_BIN = env["WINE_BIN"] ?? "/opt/deepin-wine8-stable/bin/wine";
export const WINESERVER_BIN = env["WINESERVER_BIN"] ??
  "/opt/deepin-wine8-stable/bin/wineserver";

/**
 * Launch script resolution: an explicit LAUNCH_SCRIPT wins; otherwise the
 * first existing candidate is used so bare dev runs find the repo's
 * `apps/server/scripts/launch-quark.sh` (the container has it installed at
 * /usr/local/bin/launch-quark.sh).
 */
function resolveLaunchScript(): string {
  const override = env["LAUNCH_SCRIPT"];
  if (override) return override;
  for (
    const candidate of [
      "/usr/local/bin/launch-quark.sh",
      "./scripts/launch-quark.sh",
      "apps/server/scripts/launch-quark.sh",
      "/opt/quark-server/apps/server/scripts/launch-quark.sh",
    ]
  ) {
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
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

export const LOG_LEVEL = (env["LOG_LEVEL"] ?? "info") as levellike;
