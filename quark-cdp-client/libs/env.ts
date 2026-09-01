import { load } from "@std/dotenv";
import { levellike } from "@libs/logger";

const env = await load({ export: false });

export const CDP_URL = env["CDP_URL"] ?? "http://127.0.0.1:9222";
export const RECONNECT_INTERVAL_MS = Number(
  env["RECONNECT_INTERVAL_MS"] ?? "5000",
);
export const LOG_LEVEL = (env["LOG_LEVEL"] ?? "info") as levellike;
export const SERVER_PORT = Number(env["SERVER_PORT"] ?? "3000");

// Base URL of the quark-docker manager REST API. The manager exposes
// /start /stop /restart /minimize /restore /status /healthz on this port and
// publishes an OpenAPI spec at /openapi.json. The default targets the sibling
// service in our docker-compose; override for ad-hoc setups.
export const QUARK_MANAGER_URL = env["QUARK_MANAGER_URL"] ??
  "http://quark-docker:8080";

// How long to wait after a /start call before giving up on Quark's Chromium
// CDP coming online. Cold-start under Wine is slow; 30 s is comfortable
// in practice.
export const QUARK_CDP_READY_TIMEOUT_MS = Number(
  env["QUARK_CDP_READY_TIMEOUT_MS"] ?? "30000",
);
// Polling cadence while waiting for /json/version to start responding.
export const QUARK_CDP_READY_POLL_MS = Number(
  env["QUARK_CDP_READY_POLL_MS"] ?? "500",
);
