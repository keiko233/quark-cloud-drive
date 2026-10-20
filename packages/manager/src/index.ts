/** @quark/manager — Wine/Electron process lifecycle + the CDP proxy. */
export { ProcessManager } from "./process.ts";
export { startCdpProxy } from "./cdp-proxy.ts";
export { streamManagerEvents } from "./events.ts";
export {
  createEmbeddedManager,
  createHttpManager,
  getManager,
  hasManager,
  setManager,
} from "./client.ts";
export type { ManagerApi } from "./client.ts";
