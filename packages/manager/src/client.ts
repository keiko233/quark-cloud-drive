// @quark/manager — how the rest of the app reaches the process manager.
//
// Two interchangeable transports implement the same `ManagerApi`:
//
//   embedded — a direct, in-process call into the ProcessManager instance
//              (default; what the single-container image uses)
//   http     — the manager's OpenAPI surface in another process/container
//              (host development against a containerized manager)
//
// The facade is a module singleton, mirroring the browser-handle pattern in
// @quark/drive: the entrypoint installs one transport at boot.

import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { serverContract } from "@quark/contract/server";
import type { ServerEvent, ServerStatus } from "@quark/contract/schemas";
import { streamManagerEvents } from "./manager-app.ts";
import type { ProcessManager } from "./process.ts";

/** The manager surface, independent of transport. */
export interface ManagerApi {
  healthz(): Promise<{ ok: boolean }>;
  status(): Promise<ServerStatus>;
  start(): Promise<ServerStatus>;
  stop(): Promise<ServerStatus>;
  restart(): Promise<ServerStatus>;
  minimize(): Promise<ServerStatus>;
  restore(): Promise<ServerStatus>;
  events(options: { signal?: AbortSignal }): AsyncIterable<ServerEvent>;
}

type HttpManagerClient = ContractRouterClient<typeof serverContract>;

/** A direct, in-process transport — no serialization, no port. */
export function createEmbeddedManager(
  processManager: ProcessManager,
): ManagerApi {
  return {
    healthz: () => Promise.resolve({ ok: true }),
    status: () => Promise.resolve(processManager.status()),
    start: () => processManager.start(),
    stop: () => processManager.stop(),
    restart: () => processManager.restart(),
    minimize: () => processManager.minimize(),
    restore: () => processManager.restore(),
    events: (options) => streamManagerEvents(processManager, options),
  };
}

/** A remote manager, spoken to through the shared contract over OpenAPI. */
export function createHttpManager(url: string): ManagerApi {
  const client = createORPCClient<HttpManagerClient>(
    new OpenAPILink(serverContract, { url }),
  );
  return {
    healthz: () => client.healthz(),
    status: () => client.status(),
    start: () => client.start(),
    stop: () => client.stop(),
    restart: () => client.restart(),
    minimize: () => client.minimize(),
    restore: () => client.restore(),
    events: (options) =>
      (async function* (): AsyncGenerator<ServerEvent> {
        for await (const event of await client.events(options)) {
          yield event;
        }
      })(),
  };
}

let current: ManagerApi | null = null;

/** Install the transport chosen by the entrypoint. */
export function setManager(api: ManagerApi | null): void {
  current = api;
}

export function getManager(): ManagerApi {
  if (!current) throw new Error("Manager transport is not installed");
  return current;
}

export function hasManager(): boolean {
  return current !== null;
}
