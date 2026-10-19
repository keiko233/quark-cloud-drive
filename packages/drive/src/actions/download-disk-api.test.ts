import { assertEquals } from "@jsr/std__assert";
import { test } from "bun:test";
import {
  localDownloadStatusName,
  mapLocalDownloadTask,
  QUARK_PARTIAL_DOWNLOAD_SUFFIX,
} from "./download-disk-api.ts";

test("localDownloadStatusName decodes every app status code", () => {
  assertEquals(localDownloadStatusName(-1), "error");
  assertEquals(localDownloadStatusName(0), "new");
  assertEquals(localDownloadStatusName(1), "init");
  assertEquals(localDownloadStatusName(2), "ready");
  assertEquals(localDownloadStatusName(3), "running");
  assertEquals(localDownloadStatusName(4), "pause");
  assertEquals(localDownloadStatusName(5), "cancel");
  assertEquals(localDownloadStatusName(6), "finish");
  assertEquals(localDownloadStatusName(42), "unknown");
});

test("the in-flight suffix matches what the app writes", () => {
  assertEquals(QUARK_PARTIAL_DOWNLOAD_SUFFIX, ".qkdownloading");
});

test("mapLocalDownloadTask projects a raw app task", () => {
  const task = mapLocalDownloadTask({
    id: "local-1",
    name: "a.mp4",
    status: 3,
    progress: 42.5,
    size: 2048,
    transportSize: 512,
    displaySpeed: 4096,
    path: "C:\\users\\u\\Downloads\\a.mp4",
    createTime: 1_780_000_000_000,
    updateTime: 1_780_000_001_000,
    finishTime: 0,
  });
  assertEquals(task.taskId, "local-1");
  assertEquals(task.status, "running");
  assertEquals(task.statusCode, 3);
  assertEquals(task.progressPercent, 42.5);
  assertEquals(task.sizeBytes, 2048);
  assertEquals(task.transferredBytes, 512);
  assertEquals(task.speedBytesPerSec, 4096);
  assertEquals(task.path, "C:\\users\\u\\Downloads\\a.mp4");
  assertEquals(task.createdAt, 1_780_000_000_000);
  assertEquals(task.updatedAt, 1_780_000_001_000);
  assertEquals(task.finishedAt, 0);
  assertEquals(task.error, null);
});

test("mapLocalDownloadTask clamps and survives missing fields", () => {
  const empty = mapLocalDownloadTask({});
  assertEquals(empty.taskId, "");
  assertEquals(empty.name, "");
  assertEquals(empty.status, "new");
  assertEquals(empty.progressPercent, 0);
  assertEquals(empty.sizeBytes, null);
  assertEquals(empty.transferredBytes, null);
  assertEquals(empty.speedBytesPerSec, 0);
  assertEquals(empty.path, null);
  assertEquals(empty.error, null);
  assertEquals(empty.createdAt, null);

  assertEquals(mapLocalDownloadTask({ progress: 500 }).progressPercent, 100);
  assertEquals(mapLocalDownloadTask({ progress: -5 }).progressPercent, 0);
  assertEquals(
    mapLocalDownloadTask({ errorInfo: { code: 41060, message: "gone" } }).error,
    "gone",
  );
  assertEquals(
    mapLocalDownloadTask({ errorInfo: { code: 41060 } }).error,
    "41060",
  );
  assertEquals(
    mapLocalDownloadTask({ instSpeed: 128, displaySpeed: undefined })
      .speedBytesPerSec,
    128,
  );
});
