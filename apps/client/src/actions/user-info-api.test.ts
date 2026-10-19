import { assertEquals, assertThrows } from "@std/assert";
import type { Page } from "playwright";
import {
  buildQuarkUserInfoUrl,
  fetchQuarkMemberInBrowser,
  formatQuarkCapacity,
  formatQuarkCapacityValue,
  parseQuarkMemberData,
  probeQuarkLoginInBrowser,
} from "./user-info-api.ts";
import { QuarkApiError } from "./renderer-http.ts";

function fakePage(response: { status: number; body: unknown }): Page {
  return {
    evaluate: (): Promise<unknown> =>
      Promise.resolve({
        status: response.status,
        text: JSON.stringify(response.body),
      }),
  } as unknown as Page;
}

Deno.test("buildQuarkUserInfoUrl uses the stable API contract", () => {
  const url = new URL(buildQuarkUserInfoUrl());
  assertEquals(url.pathname, "/1/clouddrive/member");
  assertEquals(url.searchParams.get("pr"), "ucpro");
  assertEquals(url.searchParams.get("fr"), "pc");
  assertEquals(url.searchParams.get("fetch_identity"), "1");
  assertEquals(url.searchParams.get("fetch_subscribe"), "1");
  assertEquals(url.searchParams.has("ut"), false);
  assertEquals(url.searchParams.has("guid"), false);
});

Deno.test("formatQuarkCapacityValue matches Quark's compact units", () => {
  assertEquals(formatQuarkCapacityValue(0), "0B");
  assertEquals(formatQuarkCapacityValue(647), "647B");
  assertEquals(formatQuarkCapacityValue(1024), "1K");
  assertEquals(formatQuarkCapacityValue(32.7 * 1024 ** 2), "32.7M");
  assertEquals(formatQuarkCapacityValue(4.3 * 1024 ** 4), "4.3T");
  assertEquals(formatQuarkCapacityValue(6 * 1024 ** 4), "6T");
});

Deno.test("formatQuarkCapacity joins used and total", () => {
  assertEquals(
    formatQuarkCapacity(4741909538222, 6597069766656),
    "4.3T/6T",
  );
});

Deno.test("parseQuarkMemberData reads capacity fields", () => {
  assertEquals(
    parseQuarkMemberData(
      {
        use_capacity: 4741909538222,
        total_capacity: 6597069766656,
      },
      { req_id: "abc" },
    ),
    {
      capacity: "4.3T/6T",
      useCapacity: 4741909538222,
      totalCapacity: 6597069766656,
      raw: {
        data: {
          use_capacity: 4741909538222,
          total_capacity: 6597069766656,
        },
        metadata: { req_id: "abc" },
      },
    },
  );
});

Deno.test("parseQuarkMemberData rejects missing capacity", () => {
  assertThrows(
    () => parseQuarkMemberData({}),
    QuarkApiError,
    "invalid capacity",
  );
});

Deno.test("fetchQuarkMemberInBrowser reads a logged-in member payload", async () => {
  const page = fakePage({
    status: 200,
    body: {
      code: 0,
      data: { use_capacity: 1024, total_capacity: 2048 },
    },
  });
  const member = await fetchQuarkMemberInBrowser(page);
  assertEquals(member.capacity, "1K/2K");
});

Deno.test("probeQuarkLoginInBrowser treats 401/31001 as logged out", async () => {
  const loggedOut = fakePage({
    status: 401,
    body: { code: 31001, message: "require login [guest]" },
  });
  assertEquals(await probeQuarkLoginInBrowser(loggedOut), {
    loggedIn: false,
    raw: { code: 31001, status: 401 },
  });

  const loggedIn = fakePage({
    status: 200,
    body: { code: 0, data: { use_capacity: 1024, total_capacity: 2048 } },
  });
  const probe = await probeQuarkLoginInBrowser(loggedIn);
  assertEquals(probe.loggedIn, true);
  assertEquals(probe.raw.data instanceof Object, true);
});
