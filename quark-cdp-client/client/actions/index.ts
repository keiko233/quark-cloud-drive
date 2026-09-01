export type {
  QuarkDownloadFileResult,
  QuarkDownloadStatus,
  QuarkDownloadStatusMode,
  QuarkDownloadTask,
  QuarkDownloadTaskOperation,
  QuarkDownloadTaskState,
  QuarkFileList,
  QuarkFileListItem,
} from "../../libs/schemas.ts";
export type { QuarkImportShareLinkResult } from "./import-share-link.ts";
export type { QuarkSetDownloadStatusResult } from "./set-download-status.ts";

import { downloadFile } from "./download-file.ts";
import { getDownloadStatus } from "./get-download-status.ts";
import { getFileList } from "./get-file-list.ts";
import { importShareLink } from "./import-share-link.ts";
import { getLoginQRCode } from "./get-login-qrcode.ts";
import { getLoginStatus } from "./get-login-status.ts";
import { getUserInfo } from "./get-user-info.ts";
import { setDownloadStatus } from "./set-download-status.ts";

export { downloadFile } from "./download-file.ts";
export { getDownloadStatus } from "./get-download-status.ts";
export { getFileList } from "./get-file-list.ts";
export { importShareLink } from "./import-share-link.ts";
export { getLoginQRCode } from "./get-login-qrcode.ts";
export { getLoginStatus } from "./get-login-status.ts";
export { getUserInfo } from "./get-user-info.ts";
export { setDownloadStatus } from "./set-download-status.ts";

export const quarkActions = [
  getLoginQRCode,
  getLoginStatus,
  getUserInfo,
  getFileList,
  downloadFile,
  getDownloadStatus,
  setDownloadStatus,
  importShareLink,
] as const;
