/** @quark/manager — Wine/Electron process lifecycle + the CDP proxy. */
export { ProcessManager } from "./process.ts";
export { startCdpProxy } from "./cdp-proxy.ts";
export {
  createManagerApp,
  createManagerRouter,
  streamManagerEvents,
} from "./manager-app.ts";
export {
  createEmbeddedManager,
  createHttpManager,
  getManager,
  hasManager,
  setManager,
} from "./client.ts";
export type { ManagerApi } from "./client.ts";
