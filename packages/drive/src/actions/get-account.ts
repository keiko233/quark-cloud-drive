import type { QuarkUserInfo } from "@quark/contract/schemas";
import { log } from "@quark/config";
import { getOperationQueue } from "../browser/context.ts";
import { userInfoCache } from "../cache/caches.ts";
import { getQuarkTransport } from "./quark-session.ts";
import { fetchQuarkMember } from "../api/user-info-api.ts";

export interface GetAccountOptions {
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
export function getAccount(
  options: GetAccountOptions = {},
): Promise<QuarkUserInfo> {
  const includeRaw = options.raw === true;
  const cached = userInfoCache.get("s");
  if (cached !== undefined) {
    return Promise.resolve(projectUserInfo(cached, includeRaw));
  }

  return getOperationQueue().run(
    "getAccount",
    { key: "getAccount" },
    async () => {
      const transport = getQuarkTransport();
      const member = await fetchQuarkMember(transport);
      log.debug(`getAccount: capacity="${member.capacity}"`);

      const result: QuarkUserInfo = {
        capacity: member.capacity,
        useCapacity: member.useCapacity,
        totalCapacity: member.totalCapacity,
        raw: member.raw,
      };
      userInfoCache.set("s", result);
      return result;
    },
  ).then((result) => projectUserInfo(result, includeRaw));
}
