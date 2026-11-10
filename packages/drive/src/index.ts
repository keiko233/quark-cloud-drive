/** Quark drive capabilities: JSON API operations and native local transfers. */
export {
  listDownloads,
  hasActiveDownloads,
  getFile,
  fetchQuarkTaskCounts,
  saveShare,
  getShareImport,
  listFiles,
  loginStatus,
  readLoginStateRaw,
  startDownload,
  listCloudTasks,
  controlDownloads,
  controlCloudTasks,
  getAccount,
} from "./actions/index.ts";
export { getQuarkTransport } from "./actions/quark-session.ts";
export {
  clearBrowser,
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

export { QuarkApiError, isQuarkLoginError } from "./api/http.ts";
