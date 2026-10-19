import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Page } from "playwright";
import {
  buildQuarkShareDetailUrl,
  buildQuarkShareDirUrl,
  buildQuarkShareSaveUrl,
  buildQuarkShareTokenUrl,
  buildQuarkTaskPollUrl,
  fetchQuarkShareDetailInBrowser,
  fetchQuarkShareSaveDirInBrowser,
  parseQuarkShareUrl,
  pollQuarkTaskInBrowser,
} from "./share-api.ts";
import { QuarkApiError } from "./renderer-http.ts";

Deno.test("parseQuarkShareUrl accepts URLs, ids and passcodes", () => {
  assertEquals(parseQuarkShareUrl("https://pan.quark.cn/s/abcdef"), {
    pwdId: "abcdef",
    passcode: null,
  });
  assertEquals(parseQuarkShareUrl("https://pan.quark.cn/s/abcdef?pwd=1234"), {
    pwdId: "abcdef",
    passcode: "1234",
  });
  assertEquals(parseQuarkShareUrl("https://pan.quark.cn/s/abcdef#pwd=9999"), {
    pwdId: "abcdef",
    passcode: "9999",
  });
  assertEquals(parseQuarkShareUrl("abcdef"), {
    pwdId: "abcdef",
    passcode: null,
  });
  assertThrows(() => parseQuarkShareUrl(""), QuarkApiError);
  assertThrows(
    () => parseQuarkShareUrl("https://example.org/x"),
    QuarkApiError,
  );
});

Deno.test("share URLs use the stable API contract", () => {
  assertEquals(
    new URL(buildQuarkShareTokenUrl()).pathname,
    "/1/clouddrive/share/sharepage/token",
  );
  assertEquals(
    new URL(buildQuarkShareSaveUrl()).pathname,
    "/1/clouddrive/share/sharepage/save",
  );

  const detail = new URL(buildQuarkShareDetailUrl("pwd", "st"));
  assertEquals(detail.pathname, "/1/clouddrive/share/sharepage/detail");
  assertEquals(detail.searchParams.get("pwd_id"), "pwd");
  assertEquals(detail.searchParams.get("stoken"), "st");
  assertEquals(detail.searchParams.get("pdir_fid"), "0");
  assertEquals(detail.searchParams.get("ver"), "2");

  assertEquals(
    new URL(buildQuarkShareDirUrl()).searchParams.get("aver"),
    "1",
  );
  assertEquals(
    new URL(buildQuarkShareDirUrl("pwd")).searchParams.get("pwd_id"),
    "pwd",
  );

  const poll = new URL(buildQuarkTaskPollUrl("task-1", 2));
  assertEquals(poll.pathname, "/1/clouddrive/task");
  assertEquals(poll.searchParams.get("task_id"), "task-1");
  assertEquals(poll.searchParams.get("retry_index"), "2");
});

function pageFor(
  responses: Array<{ status?: number; body: unknown }>,
): Page {
  let index = 0;
  return {
    evaluate: (): Promise<unknown> => {
      const response = responses[Math.min(index, responses.length - 1)];
      index++;
      return Promise.resolve({
        status: response.status ?? 200,
        text: JSON.stringify(response.body),
      });
    },
  } as unknown as Page;
}

Deno.test("fetchQuarkShareDetailInBrowser dedupes entries across pages", async () => {
  const full = Array.from({ length: 50 }, (_, i) => ({
    fid: `fid-${i}`,
    file_name: `name-${i}`,
    share_fid_token: `token-${i}`,
    dir: false,
  }));
  const page = pageFor([
    { body: { code: 0, data: { list: full } } },
    {
      body: {
        code: 0,
        data: {
          list: [{
            fid: "fid-0",
            file_name: "name-0",
            share_fid_token: "token-0",
            dir: false,
          }],
        },
      },
    },
  ]);

  const detail = await fetchQuarkShareDetailInBrowser(page, "pwd", "st");
  assertEquals(detail.entries.length, 50);
  assertEquals(detail.entries[0].fidToken, "token-0");
  assertEquals(detail.pages.length, 2);
});

Deno.test("fetchQuarkShareDetailInBrowser rejects invalid entries", async () => {
  await assertRejects(
    () =>
      fetchQuarkShareDetailInBrowser(
        pageFor([{ body: { code: 0, data: { list: [{ fid: "x" }] } } }]),
        "pwd",
        "st",
      ),
    QuarkApiError,
  );
});

Deno.test("fetchQuarkShareSaveDirInBrowser reads the default save folder", async () => {
  const dir = await fetchQuarkShareSaveDirInBrowser(
    pageFor([{
      body: {
        code: 0,
        data: { pdir_fid: "share-inbox", pdir_name: "来自：分享" },
      },
    }]),
  );
  assertEquals(dir.fid, "share-inbox");
  assertEquals(dir.name, "来自：分享");
});

Deno.test("pollQuarkTaskInBrowser waits for the finish status", async () => {
  const page = pageFor([
    { body: { code: 0, data: { status: 1 } } },
    { body: { code: 0, data: { status: 2 } } },
  ]);
  const task = await pollQuarkTaskInBrowser(page, "task-1");
  assertEquals(task.status, 2);
  assertEquals(task.statusName, "finish");
});

Deno.test("pollQuarkTaskInBrowser reports failures", async () => {
  const page = pageFor([{ body: { code: 0, data: { status: 3 } } }]);
  const task = await pollQuarkTaskInBrowser(page, "task-1");
  assertEquals(task.statusName, "fail");
  await assertRejects(() => pollQuarkTaskInBrowser(page, ""), QuarkApiError);
});
