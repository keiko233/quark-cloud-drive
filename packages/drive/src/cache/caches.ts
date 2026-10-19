import type { QuarkLoginStatus, QuarkUserInfo } from "@quark/contract/schemas";
import { TtlCache } from "./cache.ts";

// Central TTL caches for the cheap read endpoints. Write actions invalidate the
// read caches they could have made stale (see the invalidation calls in the
// action modules).

export const loginStatusCache = new TtlCache<"s", QuarkLoginStatus>(5_000);
export const userInfoCache = new TtlCache<"s", QuarkUserInfo>(30_000);
