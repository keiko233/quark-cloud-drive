import type { Page } from "playwright";
import {
  asObjectOrNull,
  buildQuarkApiUrl,
  isQuarkLoginError,
  QuarkApiError,
  readFiniteNumber,
  requestQuarkApi,
} from "./renderer-http.ts";

const USER_INFO_API_TIMEOUT_MS = 8_000;

type JsonObject = Record<string, unknown>;

/** Normalized capacity read from `GET /1/clouddrive/member`. */
export interface QuarkMemberInfo {
  capacity: string;
  useCapacity: number;
  totalCapacity: number;
  raw: JsonObject;
}

export function buildQuarkUserInfoUrl(): string {
  return buildQuarkApiUrl("/1/clouddrive/member", {
    fetch_identity: 1,
    fetch_subscribe: 1,
  });
}

/**
 * Capacity uses Quark's compact display units (`4.3T/6T`), unlike file sizes
 * which use `TB`/`GB`. Both values use binary units and one decimal place.
 */
export function formatQuarkCapacityValue(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new QuarkApiError("capacity was not a non-negative number");
  }

  const units = ["B", "K", "M", "G", "T", "P"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  const amount = unit === 0
    ? String(Math.round(value))
    : value.toFixed(1).replace(/\.0$/, "");
  return `${amount}${units[unit]}`;
}

export function formatQuarkCapacity(
  useCapacity: number,
  totalCapacity: number,
): string {
  const used = formatQuarkCapacityValue(useCapacity);
  const total = formatQuarkCapacityValue(totalCapacity);
  return `${used}/${total}`;
}

export function parseQuarkMemberData(
  data: unknown,
  metadata: JsonObject = {},
): QuarkMemberInfo {
  const member = asObjectOrNull(data);
  const useCapacity = readFiniteNumber(member?.use_capacity);
  const totalCapacity = readFiniteNumber(member?.total_capacity);
  if (
    useCapacity === undefined || useCapacity < 0 ||
    totalCapacity === undefined || totalCapacity < 0
  ) {
    throw new QuarkApiError("member API returned invalid capacity");
  }

  return {
    capacity: formatQuarkCapacity(useCapacity, totalCapacity),
    useCapacity,
    totalCapacity,
    raw: {
      ...(member ? { data: member } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  };
}

export async function fetchQuarkMemberInBrowser(
  page: Page,
): Promise<QuarkMemberInfo> {
  const envelope = await requestQuarkApi(page, {
    url: buildQuarkUserInfoUrl(),
    timeoutMs: USER_INFO_API_TIMEOUT_MS,
  });
  return parseQuarkMemberData(envelope.data, envelope.metadata);
}

/**
 * Cheap authentication probe: the member endpoint answers 401/`31001` when the
 * renderer session is not logged in. Capacity is not validated here, so this
 * never throws for a logged-out session.
 */
export async function probeQuarkLoginInBrowser(
  page: Page,
): Promise<{ loggedIn: boolean; raw: JsonObject }> {
  try {
    const envelope = await requestQuarkApi(page, {
      url: buildQuarkUserInfoUrl(),
      timeoutMs: USER_INFO_API_TIMEOUT_MS,
    });
    return { loggedIn: true, raw: { data: envelope.data } };
  } catch (error) {
    if (isQuarkLoginError(error)) {
      const reason = error as QuarkApiError;
      return {
        loggedIn: false,
        raw: {
          ...(reason.code !== null ? { code: reason.code } : {}),
          ...(reason.status !== null ? { status: reason.status } : {}),
        },
      };
    }
    throw error;
  }
}
