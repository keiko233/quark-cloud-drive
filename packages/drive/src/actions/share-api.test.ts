import {
  deepStrictEqual as assertEquals,
  rejects as assertRejects,
  throws as assertThrows,
} from "node:assert/strict";
import { test } from "bun:test";
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
  readQuarkTaskSavedFids,
  saveQuarkShareInBrowser,
} from "./share-api.ts";
import { QuarkApiError } from "./renderer-http.ts";

test("parseQuarkShareUrl accepts URLs, ids and passcodes", () => {
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

test("share URLs use the stable API contract", () => {
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

test("fetchQuarkShareDetailInBrowser dedupes entries across pages", async () => {
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

test("fetchQuarkShareDetailInBrowser rejects invalid entries", async () => {
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

test("fetchQuarkShareSaveDirInBrowser reads the default save folder", async () => {
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

/** Capture the renderer request so a test can assert on the exact body. */
function capturingPage(response: { status?: number; body: unknown }): {
  page: Page;
  requests: Array<{ method?: string; url: string; body?: unknown }>;
} {
  const requests: Array<{ method?: string; url: string; body?: unknown }> = [];
  const page = {
    evaluate: (
      _fn: unknown,
      request: { method?: string; url: string; body?: unknown },
    ) => {
      requests.push(request);
      return Promise.resolve({
        status: response.status ?? 200,
        text: JSON.stringify(response.body),
      });
    },
  } as unknown as Page;
  return { page, requests };
}

test("saveQuarkShareInBrowser posts the documented save body", async () => {
  const { page, requests } = capturingPage({
    body: { code: 0, data: { task_id: "task-9" } },
  });
  const result = await saveQuarkShareInBrowser(page, {
    pwdId: "pwd-1",
    stoken: "st-1",
    toDirFid: "dest-fid",
    entries: [
      { fid: "fid-a", fidToken: "tok-a", name: "a.mkv", dir: false, raw: {} },
      { fid: "fid-b", fidToken: "tok-b", name: "b.mkv", dir: false, raw: {} },
    ],
  });

  assertEquals(result.taskId, "task-9");
  assertEquals(
    new URL(requests[0].url).pathname,
    "/1/clouddrive/share/sharepage/save",
  );
  assertEquals(requests[0].method, "POST");
  // `pdir_fid` is the share root, `to_pdir_fid` is the drive destination.
  // Getting this backwards makes Quark save nothing.
  assertEquals(requests[0].body, {
    pwd_id: "pwd-1",
    stoken: "st-1",
    to_pdir_fid: "dest-fid",
    pdir_fid: "0",
    scene: "link",
    fid_list: ["fid-a", "fid-b"],
    fid_token_list: ["tok-a", "tok-b"],
  });
});

test("readQuarkTaskSavedFids reads save_as_top_fids", () => {
  assertEquals(
    readQuarkTaskSavedFids({ save_as: { save_as_top_fids: ["f1", "f2"] } }),
    ["f1", "f2"],
  );
  assertEquals(readQuarkTaskSavedFids({ save_as: {} }), []);
  assertEquals(readQuarkTaskSavedFids({}), []);
  assertEquals(
    readQuarkTaskSavedFids({ save_as: { save_as_top_fids: ["f1", 2, ""] } }),
    ["f1"],
  );
});

test("pollQuarkTaskInBrowser waits for the finish status", async () => {
  const page = pageFor([
    { body: { code: 0, data: { status: 1 } } },
    { body: { code: 0, data: { status: 2 } } },
  ]);
  const task = await pollQuarkTaskInBrowser(page, "task-1");
  assertEquals(task.status, 2);
  assertEquals(task.statusName, "finish");
});

test("pollQuarkTaskInBrowser reports failures", async () => {
  const page = pageFor([{ body: { code: 0, data: { status: 3 } } }]);
  const task = await pollQuarkTaskInBrowser(page, "task-1");
  assertEquals(task.statusName, "fail");
  await assertRejects(() => pollQuarkTaskInBrowser(page, ""), QuarkApiError);
});
