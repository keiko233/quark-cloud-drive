// Attaches the Deno KV persistence hooks to the operation queue (task history)
// and the download action (download records).

import { getOperationQueue } from "../browser/context.ts";
import { log } from "../logger.ts";
import { kvStore, type TaskRecord } from "./kv.ts";

const pendingTasks = new Map<string, TaskRecord>();

/** Wire queue lifecycle events into KV task history. Idempotent-ish. */
export function attachStoreHooks(): void {
  getOperationQueue().events.subscribe("operation", (e) => {
    const id = e.key ?? e.label;
    if (e.phase === "started") {
      pendingTasks.set(id, {
        key: e.key ?? e.label,
        label: e.label,
        status: "started",
        startedAt: e.startedAt,
      });
      return;
    }
    const record = pendingTasks.get(id);
    if (!record) return;
    pendingTasks.delete(id);
    record.status = e.phase === "done" ? "done" : "error";
    record.endedAt = Date.now();
    kvStore.recordTask(record).catch((err) =>
      log.warn(`failed to record task to KV: ${err}`)
    );
  });
}
