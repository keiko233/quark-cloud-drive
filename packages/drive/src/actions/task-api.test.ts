import {
  deepStrictEqual as assertEquals,
  rejects as assertRejects,
  throws as assertThrows,
} from "node:assert/strict";
import { test } from "bun:test";
import type { Page } from "playwright";
import {
  buildQuarkTaskCountUrl,
  buildQuarkTaskListUrl,
  decodeTaskCursor,
  encodeTaskCursor,
  fetchQuarkTaskCountsInBrowser,
  fetchQuarkTaskPageInBrowser,
  mapQuarkTask,
  parseQuarkTaskCounts,
  readTaskCursor,
  taskStatusName,
  toTaskTypeCsv,
  updateQuarkTasksInBrowser,
} from "./task-api.ts";
import { QuarkApiError } from "./renderer-http.ts";

test("buildQuarkTaskListUrl uses the stable API contract", () => {
  const url = new URL(buildQuarkTaskListUrl());
  assertEquals(url.pathname, "/1/clouddrive/task/current/list");
  assertEquals(url.searchParams.get("pr"), "ucpro");
  assertEquals(url.searchParams.get("fr"), "pc");
  assertEquals(url.searchParams.get("_size"), "20");
  assertEquals(url.searchParams.has("_page"), false);
  assertEquals(url.searchParams.has("status"), false);
  assertEquals(url.searchParams.has("task_type"), false);
});

test("buildQuarkTaskListUrl maps status, type and cursor", () => {
  const url = new URL(buildQuarkTaskListUrl({
    status: "running",
    type: "offline_download,cloud_save",
    size: 100,
    cursor: encodeTaskCursor("task-9", 1_780_000_000_000),
  }));
  assertEquals(url.searchParams.get("status"), "1");
  assertEquals(url.searchParams.get("task_type"), "5,6");
  assertEquals(url.searchParams.get("_size"), "100");
  assertEquals(url.searchParams.get("filter_end_task_id"), "task-9");
  assertEquals(url.searchParams.get("filter_end_time"), "1780000000000");
});

test("task size is clamped and 'all' drops the status filter", () => {
  assertEquals(
    new URL(buildQuarkTaskListUrl({ status: "all", size: 5_000 })).searchParams
      .get("status"),
    null,
  );
  assertEquals(
    new URL(buildQuarkTaskListUrl({ size: 5_000 })).searchParams.get("_size"),
    "100",
  );
  assertEquals(
    new URL(buildQuarkTaskListUrl({ size: 0 })).searchParams.get("_size"),
    "1",
  );
});

test("toTaskTypeCsv accepts names and codes", () => {
  assertEquals(toTaskTypeCsv("unzip"), "4");
  assertEquals(toTaskTypeCsv("4, 6"), "4,6");
  assertThrows(() => toTaskTypeCsv("nope"), QuarkApiError);
});

test("cursor encode/decode round-trips and rejects bad input", () => {
  const cursor = encodeTaskCursor("abc", 123);
  assertEquals(decodeTaskCursor(cursor), { endTaskId: "abc", endTime: "123" });
  assertEquals(decodeTaskCursor("no-separator"), null);
  assertEquals(decodeTaskCursor("123:"), null);
  assertEquals(decodeTaskCursor("x:abc"), null);
  assertThrows(
    () => buildQuarkTaskListUrl({ cursor: "123:" }),
    QuarkApiError,
  );
});

test("buildQuarkTaskCountUrl covers every status and type", () => {
  const url = new URL(buildQuarkTaskCountUrl());
  assertEquals(url.pathname, "/1/clouddrive/task/count");
  assertEquals(url.searchParams.get("status"), "0,1,2,3,4");
  assertEquals(
    url.searchParams.get("task_type"),
    "0,1,2,3,4,5,6,7,8,9,10",
  );
  assertEquals(
    new URL(buildQuarkTaskCountUrl("unzip")).searchParams.get("task_type"),
    "4",
  );
});

test("parseQuarkTaskCounts tolerates sparse maps", () => {
  assertEquals(parseQuarkTaskCounts({ count: { "2": 82 } }), {
    todo: 0,
    running: 0,
    finish: 82,
    fail: 0,
    pause: 0,
    total: 82,
  });
  assertEquals(parseQuarkTaskCounts({ count: { "0": 1, "1": 2 } }).total, 3);
  assertEquals(parseQuarkTaskCounts(null).total, 0);
});

test("taskStatusName rejects unknown codes", () => {
  assertEquals(taskStatusName(2), "finish");
  assertThrows(() => taskStatusName(99), QuarkApiError);
});

test("mapQuarkTask decodes per-mille progress", () => {
  const task = mapQuarkTask({
    task_id: "task-1",
    task_type: 5,
    status: 1,
    task_title: "title",
    size: 1000,
    progress: 250,
    file_num: 2,
    completed_num: 1,
    dir_fid: "folder-fid",
    download_type: "MAGNET",
    created_at: 1_780_000_000,
    updated_at: 1_780_000_001_000,
  });
  assertEquals(task.taskTypeName, "offline_download");
  assertEquals(task.status, "running");
  assertEquals(task.progressPercent, 25);
  assertEquals(task.transferredBytes, 250);
  assertEquals(task.createdAt, 1_780_000_000_000);
  assertEquals(task.updatedAt, 1_780_000_001_000);
});

test("readTaskCursor needs both metadata fields", () => {
  assertEquals(
    readTaskCursor({ filter_end_task_id: "a", filter_end_time: 7 }),
    "7:a",
  );
  assertEquals(readTaskCursor({ filter_end_task_id: "a" }), null);
  assertEquals(readTaskCursor({ filter_end_time: 7 }), null);
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

test("fetchQuarkTaskPageInBrowser maps tasks and gates the cursor", async () => {
  const page = pageFor([{
    body: {
      code: 0,
      data: {
        list: [
          {
            task_id: "a",
            task_type: 5,
            status: 2,
            task_title: "t",
            progress: 1000,
          },
          {
            task_id: "b",
            task_type: 5,
            status: 2,
            task_title: "t",
            progress: 1000,
          },
        ],
      },
      metadata: { filter_end_task_id: "b", filter_end_time: 9 },
    },
  }]);

  const result = await fetchQuarkTaskPageInBrowser(page, { size: 2 });
  assertEquals(result.tasks.map((task) => task.taskId), ["a", "b"]);
  assertEquals(result.cursor, "9:b");
  assertEquals(result.metadata.filter_end_task_id, "b");

  // A short page never advertises a cursor.
  const shortPage = await fetchQuarkTaskPageInBrowser(
    pageFor([{
      body: {
        code: 0,
        data: {
          list: [{ task_id: "a", task_type: 5, status: 2, progress: 1000 }],
        },
        metadata: { filter_end_task_id: "a", filter_end_time: 9 },
      },
    }]),
    { size: 2 },
  );
  assertEquals(shortPage.cursor, null);
});

test("fetchQuarkTaskPageInBrowser rejects invalid data", async () => {
  await assertRejects(
    () =>
      fetchQuarkTaskPageInBrowser(pageFor([{ body: { code: 0, data: {} } }])),
    QuarkApiError,
  );
});

test("fetchQuarkTaskCountsInBrowser and updateQuarkTasksInBrowser", async () => {
  const countsPage = pageFor([{
    body: { code: 0, data: { count: { "1": 3, "2": 1 } } },
  }]);
  const counts = await fetchQuarkTaskCountsInBrowser(
    countsPage,
    "offline_download",
  );
  assertEquals(counts.counts.running, 3);

  const mutationPage = pageFor([{
    body: { code: 0, data: { ignored: true } },
  }]);
  const result = await updateQuarkTasksInBrowser(
    mutationPage,
    ["a", "b"],
    "resume",
  );
  assertEquals(result.raw.ignored, true);
});
