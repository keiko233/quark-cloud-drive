import assert, { deepStrictEqual as assertEquals } from "node:assert/strict";
import { test } from "bun:test";
import type {
  QuarkFileList,
  QuarkShareImport,
  QuarkShareSubmission,
} from "@quark/contract/schemas";

const url = process.env.QUARK_E2E_SHARE_URL;
const toFid = process.env.QUARK_E2E_SHARE_TO_FID;
const api = process.env.QUARK_API_URL ?? "http://127.0.0.1:3000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(api + path, init);
  assertEquals(response.status, 200, `${init?.method ?? "GET"} ${path}`);
  return response.json() as Promise<T>;
}

test.skipIf(process.env.QUARK_E2E !== "1" || !url || !toFid)(
  "a submitted Quark share reaches completion and writes into the test folder",
  async () => {
    assert(url && toFid);
    const destination = `/files?fid=${encodeURIComponent(toFid)}`;
    const before = await request<QuarkFileList>(destination);
    const originalFids = new Set(before.items.map((item) => item.fid));

    const submitted = await request<QuarkShareSubmission>("/share-imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, toFid }),
    });
    assertEquals(submitted.status, "submitted");
    assertEquals(submitted.toDirFid, toFid);
    assert(submitted.taskId);

    let retryIndex = 0;
    const deadline = Date.now() + 80_000;
    while (Date.now() < deadline) {
      const result = await request<QuarkShareImport>(
        `/share-imports?taskId=${encodeURIComponent(submitted.taskId)}&retryIndex=${retryIndex}`,
      );
      if (result.status !== "pending") {
        assertEquals(result.status, "completed", result.error ?? "Share save did not complete");
        const after = await request<QuarkFileList>(destination);
        const newFids = new Set(after.items.map((item) => item.fid).filter((fid) => !originalFids.has(fid)));
        assert(newFids.size, "No new entries were found in the test destination");
        assert(result.savedFids.every((fid) => newFids.has(fid)));
        return;
      }
      assert(result.nextRetryIndex !== null);
      retryIndex = result.nextRetryIndex;
      await Bun.sleep(1_000);
    }
    assert.fail("Quark still reported the share task as pending");
  },
  120_000,
);
