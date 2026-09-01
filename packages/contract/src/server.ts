import { eventIterator, oc } from "@orpc/contract";
import {
  HealthzSchema,
  ServerEventSchema,
  ServerStatusSchema,
} from "./schemas.ts";

/**
 * apps/server contract — the thin process manager surface.
 *
 * apps/server owns ONLY process lifecycle + window state + the CDP proxy.
 * All idle/sleep policy lives in apps/client; this contract deliberately
 * carries no idle-timer / cpu-threshold fields.
 *
 * apps/client consumes this via a typed oRPC client (see apps/client).
 */
export const serverContract = oc.router({
  healthz: oc.route({
    method: "GET",
    path: "/healthz",
    description: "Liveness probe. Returns 200 while the manager is up.",
  }).output(HealthzSchema),

  status: oc.route({
    method: "GET",
    path: "/status",
    description: [
      "Snapshot of the process state: state, tracked PID, authoritative",
      "CDP liveness, last CDP activity, and lifecycle counters. No idle",
      "policy data — idle decisions live in apps/client.",
    ].join("\n"),
  }).output(ServerStatusSchema),

  start: oc.route({
    method: "POST",
    path: "/start",
    description: [
      "Start Quark (or restore it from minimized). Idempotent — safe to",
      "call when already running. Waits for the CDP port to come online.",
    ].join("\n"),
  }).output(ServerStatusSchema),

  stop: oc.route({
    method: "POST",
    path: "/stop",
    description: "Stop Quark and free its process group. Idempotent.",
  }).output(ServerStatusSchema),

  restart: oc.route({
    method: "POST",
    path: "/restart",
    description: "Stop then start. Useful after settings changes.",
  }).output(ServerStatusSchema),

  minimize: oc.route({
    method: "POST",
    path: "/minimize",
    description: [
      "Minimize the Quark window (X unmap) — keeps the process alive but",
      "lets Chromium throttle to free CPU.",
    ].join("\n"),
  }).output(ServerStatusSchema),

  restore: oc.route({
    method: "POST",
    path: "/restore",
    description: "Restore the minimized Quark window (X map).",
  }).output(ServerStatusSchema),

  events: oc.route({
    method: "GET",
    path: "/events",
    description: [
      "SSE stream of process transitions and CDP activity. Consumers use",
      "this for live status without polling /status.",
    ].join("\n"),
  }).output(eventIterator(ServerEventSchema)),
});
