import { ORPCError } from "@orpc/server";
import { log } from "@quark/config";
import { processManager } from "@quark/manager";
import { readLoginStateRaw } from "@quark/drive";
import { autoWakeBlockReason, ensureQuarkAwake } from "./monitor/wake.ts";
import { connect, hasAttachedSession } from "./session/connect.ts";

/** Shared policy for REST and MCP; only real requests can wake a sleeping app. */
async function requireSession({ login = true } = {}): Promise<void> {
  const blocked = await autoWakeBlockReason();
  if (blocked) throw new ORPCError("SERVICE_UNAVAILABLE", { message: blocked });

  try {
    if (!hasAttachedSession()) {
      await ensureQuarkAwake();
      await connect();
    }
  } catch (error) {
    log.warn("Quark session not ready:", error);
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "Quark session is not ready; check /status and retry.",
    });
  }

  if (login && readLoginStateRaw() !== "logged_in") {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Sign in to Quark with login_qr_code (GET /login/qrcode) and retry.",
    });
  }
}

let activeRequests = 0;

export function hasDriveRequests(): boolean {
  return activeRequests > 0;
}

export async function withDriveSession<T>(
  run: () => Promise<T>,
  options?: { login?: boolean },
): Promise<T> {
  activeRequests++;
  try {
    await requireSession(options);
    processManager.markActivity();
    try {
      return await run();
    } finally {
      processManager.markActivity();
    }
  } finally {
    activeRequests--;
  }
}
