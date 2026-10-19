import type { QuarkUserInfo } from "@quark/contract/schemas";
import { log } from "../logger.ts";
import { getOperationQueue } from "../browser/context.ts";
import { userInfoCache } from "../cache/caches.ts";
import { getQuarkPage } from "./browser-session.ts";
import { fetchQuarkMemberInBrowser } from "./user-info-api.ts";

export interface UserInfoOptions {
  raw?: boolean;
}

function projectUserInfo(
  result: QuarkUserInfo,
  includeRaw: boolean,
): QuarkUserInfo {
  if (includeRaw) return result;
  const { raw: _raw, ...rest } = result;
  return rest;
}

/**
 * Read account capacity from Quark's member API. Cached for 30s; only the
 * `raw` projection differs between callers, so the cache always holds the
 * full payload.
 */
export function userInfo(
  options: UserInfoOptions = {},
): Promise<QuarkUserInfo> {
  const includeRaw = options.raw === true;
  const cached = userInfoCache.get("s");
  if (cached !== undefined) {
    return Promise.resolve(projectUserInfo(cached, includeRaw));
  }

  return getOperationQueue().run(
    "userInfo",
    { key: "userInfo" },
    async () => {
      const page = await getQuarkPage();
      const member = await fetchQuarkMemberInBrowser(page);
      log.debug(`userInfo: capacity="${member.capacity}"`);

      const result: QuarkUserInfo = {
        capacity: member.capacity,
        useCapacity: member.useCapacity,
        totalCapacity: member.totalCapacity,
        raw: member.raw,
      };
      userInfoCache.set("s", result);
      return projectUserInfo(result, includeRaw);
    },
  );
}
