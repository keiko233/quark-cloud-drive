import type {
  QuarkDownloadFileResult,
  QuarkDownloadStatus,
  QuarkFileList,
} from "@quark/contract/schemas";
import { TtlCache } from "./cache.ts";

// Central TTL caches. Write actions invalidate the read caches they could
// have made stale (see the invalidation calls in the action modules).

export const fileListCache = new TtlCache<string, QuarkFileList>(30_000);
export const downloadStatusCache = new TtlCache<string, QuarkDownloadStatus>(
  5_000,
);
export const loginStatusCache = new TtlCache<"s", { loggedIn: boolean }>(5_000);
export const userInfoCache = new TtlCache<"s", { capacity: string }>(30_000);
export const downloadFileCache = new TtlCache<string, QuarkDownloadFileResult>(
  5_000,
);
