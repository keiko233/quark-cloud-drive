/** @quark/manager — local Wine lifecycle and the optional diagnostic proxy. */
import { ProcessManager } from "./process.ts";

export const processManager = new ProcessManager();
export { ProcessManager };
export { startCdpProxy } from "./cdp-proxy.ts";
export { streamManagerEvents } from "./events.ts";
