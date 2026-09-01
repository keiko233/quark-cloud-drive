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

export const SERVER_PORT = envInt("SERVER_PORT", 3000);

// Base URL of apps/server (the process manager). The client talks to it via
// the shared serverContract.
export const SERVER_URL = env["SERVER_URL"] ?? "http://server:8080";

// CDP proxy port on apps/server — the client connects to it directly.
export const CDP_URL = env["CDP_URL"] ?? "http://server:9223";

export const RECONNECT_INTERVAL_MS = envInt("RECONNECT_INTERVAL_MS", 5000);

export const LOG_LEVEL = (env["LOG_LEVEL"] ?? "info") as levellike;

// How long to wait after a /start call before giving up on Quark's CDP
// coming online.
export const CDP_READY_TIMEOUT_MS = envInt("CDP_READY_TIMEOUT_MS", 30000);
export const CDP_READY_POLL_MS = envInt("CDP_READY_POLL_MS", 500);

// Idle policy — the client (NOT the server) owns these decisions.
export const IDLE_MINIMIZE_AFTER_MS = envInt(
  "CLIENT_IDLE_MINIMIZE_AFTER_MS",
  300_000,
);
export const IDLE_STOP_AFTER_MS = envInt(
  "CLIENT_IDLE_STOP_AFTER_MS",
  1_800_000,
);
export const IDLE_CHECK_INTERVAL_MS = envInt(
  "CLIENT_IDLE_CHECK_INTERVAL_MS",
  10_000,
);

// Operation queue defaults.
export const QUEUE_OPERATION_TIMEOUT_MS = envInt(
  "QUEUE_OPERATION_TIMEOUT_MS",
  60_000,
);
export const QUEUE_MAX_WAITING = envInt("QUEUE_MAX_WAITING", 100);

// Deno KV path for task/download history.
export const CLIENT_KV_PATH = env["CLIENT_KV_PATH"] ?? "./data/kv.sqlite3";
