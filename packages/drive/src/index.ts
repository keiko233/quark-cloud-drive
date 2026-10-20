/**
 * @quark/drive — the logged-in Quark session and its business capabilities.
 *
 * Everything here talks to Quark's cloud-drive JSON API through the renderer
 * session and returns plain data. No HTTP surface, no idle policy, and no
 * process lifecycle: those live in @quark/service and @quark/manager.
 */
export {
  downloadFile,
  downloadTaskList,
  fileInfo,
  fetchQuarkTaskCountsInBrowser,
  importShareLink,
  listFile,
  loginStatus,
  readLoginStateRaw,
  startDownload,
  taskList,
  updateDownloadTask,
  updateTask,
  userInfo,
} from "./actions/index.ts";
export { getQuarkPage } from "./actions/browser-session.ts";
export {
  getBrowser,
  getOperationQueue,
  setBrowser,
} from "./browser/context.ts";
export {
  getBrowserContext,
  getHomePage,
} from "./browser/page-utils.ts";
export { kvStore } from "./store/kv.ts";
export type { TaskRecord } from "./store/kv.ts";
export { attachStoreHooks } from "./store/hooks.ts";
export { getRuntimeConfig, updateRuntimeConfig } from "./store/config.ts";
export { Channel, OperationQueue } from "./queue/operation-queue.ts";
export { findPageByUrl } from "./utils.ts";
export {
  QUARK_HOME_PAGE_URL,
  QUARK_LOGIN_PAGE_URL,
  QUARK_MEMBER_PAGE_URL,
} from "./consts.ts";
