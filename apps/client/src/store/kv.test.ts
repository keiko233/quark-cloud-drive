import { assertEquals } from "@std/assert";
import { KvStore } from "./kv.ts";

async function freshStore(): Promise<KvStore> {
  const store = new KvStore();
  await store.open();
  return store;
}

Deno.test("KvStore: record and list tasks (newest first)", async () => {
  const store = await freshStore();
  const t1 = Date.now();
  await store.recordTask({
    key: "downloadFile:/a/b.txt",
    label: "downloadFile /a/b.txt",
    status: "done",
    startedAt: t1,
    endedAt: t1 + 100,
  });
  const t2 = t1 + 1000;
  await store.recordTask({
    key: "getFileList:/a",
    label: "getFileList /a",
    status: "error",
    startedAt: t2,
    endedAt: t2 + 50,
    error: "boom",
  });

  const tasks = await store.listTasks();
  assertEquals(tasks[0].key, "getFileList:/a");
  assertEquals(tasks[0].status, "error");
  assertEquals(tasks[0].error, "boom");
  const earlier = tasks.find((t) => t.key === "downloadFile:/a/b.txt");
  assertEquals(earlier?.status, "done");
  store.close();
});

Deno.test("KvStore: record and list downloads", async () => {
  const store = await freshStore();
  await store.recordDownload({
    name: "b.txt",
    path: "/a/b.txt",
    queuedAt: Date.now(),
  });
  const downloads = await store.listDownloads();
  assertEquals(downloads[0].name, "b.txt");
  assertEquals(downloads[0].path, "/a/b.txt");
  store.close();
});

Deno.test("KvStore: settings round-trip", async () => {
  const store = await freshStore();
  assertEquals(await store.getSetting("never"), null);
  await store.setSetting("idle.minutes", 5);
  assertEquals(await store.getSetting<number>("idle.minutes"), 5);
  store.close();
});
