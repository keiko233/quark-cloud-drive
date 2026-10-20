#!/usr/bin/env bun

import { MANAGER_MODE, MANAGER_URL, QUARK_API_PORT } from "@quark/config";
import type { ServerStatus } from "@quark/contract/schemas";

const BASE_URL = (
  MANAGER_MODE === "http"
    ? MANAGER_URL
    : `http://127.0.0.1:${QUARK_API_PORT}`
).replace(/\/+$/, "");
const POLL_MS = 1_000;
const RETRY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;

const shutdown = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown.abort());
}

function log(message: string): void {
  console.log(`[dev:client] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => timeout.abort();
  shutdown.signal.addEventListener("abort", abort, { once: true });
  if (shutdown.signal.aborted) timeout.abort();
  try {
    return await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: timeout.signal,
    });
  } finally {
    clearTimeout(timer);
    shutdown.signal.removeEventListener("abort", abort);
  }
}

async function readStatus(): Promise<ServerStatus> {
  const response = await request("/status");
  if (!response.ok) {
    throw new Error(`GET /status returned HTTP ${response.status}`);
  }
  return await response.json() as ServerStatus;
}

async function waitForManager(): Promise<boolean> {
  let waiting = false;
  while (!shutdown.signal.aborted) {
    try {
      const response = await request("/healthz");
      if (response.ok) {
        if (waiting) log(`manager is back at ${BASE_URL}`);
        return true;
      }
    } catch {
      // The manager is normally absent for a second or two during reloads.
    }
    if (!waiting) {
      log(`waiting for manager at ${BASE_URL}`);
      waiting = true;
    }
    await sleep(POLL_MS);
  }
  return false;
}

/**
 * Start Quark once per dev-client process. We deliberately do not restart it
 * after a manual or idle stop: that policy belongs to the service.
 */
async function ensureClient(): Promise<boolean> {
  const status = await readStatus();
  if (status.alive) {
    log(
      `Quark already running (state=${status.state}, pid=${status.pid ?? "-"})`,
    );
    return true;
  }

  log("requesting Quark start");
  const response = await request("/start", { method: "POST" });
  if (!response.ok) {
    throw new Error(`POST /start returned HTTP ${response.status}`);
  }
  const started = await response.json() as ServerStatus;
  log(
    `Quark start requested (state=${started.state}, pid=${started.pid ?? "-"})`,
  );
  return true;
}

async function followEvents(): Promise<void> {
  const response = await fetch(`${BASE_URL}/events`, {
    headers: { accept: "text/event-stream" },
    signal: shutdown.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`GET /events returned HTTP ${response.status}`);
  }

  log("following Quark process events");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastState: string | null = null;

  while (!shutdown.signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(
      /\r\n/g,
      "\n",
    );

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          const event = JSON.parse(data) as {
            type?: string;
            state?: string;
          };
          if (event.type === "process" && event.state !== lastState) {
            lastState = event.state ?? null;
            log(`Quark state: ${event.state}`);
          }
        } catch {
          // Ignore malformed/forward-incompatible events.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

async function main(): Promise<void> {
  log(`manager endpoint: ${BASE_URL}`);
  let clientReady = false;

  while (!shutdown.signal.aborted) {
    if (!(await waitForManager())) break;

    if (!clientReady) {
      try {
        clientReady = await ensureClient();
      } catch (error) {
        log(
          `client startup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await sleep(RETRY_MS);
        continue;
      }
    }

    try {
      await followEvents();
    } catch (error) {
      if (!shutdown.signal.aborted) {
        log(
          `event stream disconnected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (!shutdown.signal.aborted) await sleep(POLL_MS);
  }

  log("stopped");
}

if (import.meta.main) {
  await main();
}
