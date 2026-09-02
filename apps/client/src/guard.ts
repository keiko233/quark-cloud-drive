import type { GuardOperation } from "@quark/contract/schemas";
import { ORPCError } from "@orpc/server";
import { serverClient } from "./server-client/index.ts";
import { readLoginStateRaw } from "./actions/login-status.ts";
import { getRuntimeConfig } from "./store/config.ts";

export class GuardError extends ORPCError<"FORBIDDEN", unknown> {
  constructor(message: string) {
    super("FORBIDDEN", { message });
    this.name = "GuardError";
  }
}

export class NotReadyError extends ORPCError<"SERVICE_UNAVAILABLE", unknown> {
  constructor(message: string) {
    super("SERVICE_UNAVAILABLE", { message });
    this.name = "NotReadyError";
  }
}

/**
 * Central policy gate for browser operations. Lifecycle and login-help
 * endpoints intentionally do not use this gate, so a logged-out instance can
 * still be started and receive a QR code.
 */
export async function assertOperationAllowed(
  operation: GuardOperation,
): Promise<void> {
  const process = await serverClient.status();
  if (process.state === "starting") {
    throw new NotReadyError("Quark is starting; retry when status is running");
  }
  if (!process.alive || process.state === "stopped") {
    throw new NotReadyError("Quark is stopped; retry after it is started");
  }

  const config = await getRuntimeConfig();
  if (!config.requireLoginFor.includes(operation)) return;

  const login = readLoginStateRaw();
  if (login === "logged_out") {
    throw new GuardError(
      `operation "${operation}" is blocked because Quark is not logged in`,
    );
  }
  if (login === "unknown") {
    throw new GuardError(
      `operation "${operation}" is blocked because login state is unknown`,
    );
  }
}
