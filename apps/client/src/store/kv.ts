// Deno KV-backed persistence for task history and settings.
//
// Deno KV uses a local SQLite file (CLIENT_KV_PATH). Namespaces:
//   ["tasks"]    — one row per operation {key,label,status,startedAt,endedAt,error?}
//   ["settings"] — user-facing config (idle thresholds, etc.)

import { CLIENT_KV_PATH } from "../env.ts";
import { log } from "../logger.ts";

export interface TaskRecord {
  key: string;
  label: string;
  status: "started" | "done" | "error";
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export class KvStore {
  private kv: Deno.Kv | null = null;

  async open(): Promise<void> {
    if (this.kv) return;
    const parent = CLIENT_KV_PATH.includes("/")
      ? CLIENT_KV_PATH.slice(0, CLIENT_KV_PATH.lastIndexOf("/"))
      : ".";
    Deno.mkdirSync(parent, { recursive: true });
    this.kv = await Deno.openKv(CLIENT_KV_PATH);
    log.debug(`KV store opened at ${CLIENT_KV_PATH}`);
  }

  close(): void {
    if (!this.kv) return;
    this.kv.close();
    this.kv = null;
  }

  private ensure(): Deno.Kv {
    if (!this.kv) throw new Error("KvStore not open — call open() first");
    return this.kv;
  }

  // ── tasks ──────────────────────────────────────────────────────────────────

  async recordTask(record: TaskRecord): Promise<void> {
    const kv = this.ensure();
    const key = ["tasks", record.startedAt, record.key];
    await kv.set(key, record);
    // Keep the store bounded: drop everything older than 30 days.
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const it = kv.list<TaskRecord>({ prefix: ["tasks"] });
    for await (const entry of it) {
      const ts = entry.key[1] as number;
      if (ts < cutoff) {
        await kv.delete(entry.key);
      }
    }
  }

  async listTasks(limit = 100): Promise<TaskRecord[]> {
    const kv = this.ensure();
    const records: TaskRecord[] = [];
    const it = kv.list<TaskRecord>({ prefix: ["tasks"] });
    for await (const entry of it) {
      records.push(entry.value);
    }
    return records.slice(-limit).reverse();
  }

  // ── settings ───────────────────────────────────────────────────────────────

  async getSetting<T>(key: string): Promise<T | null> {
    const entry = await this.ensure().get<T>(["settings", key]);
    return entry.value ?? null;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    await this.ensure().set(["settings", key], value);
  }
}

/** Singleton shared by the queue event hook and the router. */
export const kvStore = new KvStore();
