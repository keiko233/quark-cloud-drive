/**
 * @quark/service — the public surface plus the policy that drives the Quark
 * process.
 *
 * Responsibility split:
 *   rpc/       REST + OpenAPI + MCP (the contracted business API)
 *   session/   attaching to the logged-in renderer and keeping it alive
 *   monitor/   idle/sleep decisions and the runtime status snapshot
 *   guard.ts   per-operation policy gate
 *   bootstrap  the composition root that wires @quark/manager + @quark/drive
 */
export { bootstrap } from "./bootstrap.ts";
export type { BootstrapOptions } from "./bootstrap.ts";
export { startService } from "./rpc/index.ts";
export { sleeper } from "./rpc/runtime.ts";
export { connect } from "./session/connect.ts";
