// SQLite-backed persistence for task history and settings.
//
// The store keeps the two Deno KV namespaces as one table (QUARK_KV_PATH):
//   ns = "tasks"    — one row per operation, ordered by (ts, id), where the
//                     old `["tasks", startedAt, key]` key put the timestamp
//                     before the record key.
//   ns = "settings" — user-facing config (idle thresholds, etc.)

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { KV_PATH } from "@quark/config";
import { log } from "@quark/config";

export interface TaskRecord {
  key: string;
  label: string;
  status: "started" | "done" | "error";
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export class KvStore {
  private db: Database | null = null;

  async open(): Promise<void> {
    if (this.db) return;
    const parent = KV_PATH.includes("/")
      ? KV_PATH.slice(0, KV_PATH.lastIndexOf("/"))
      : ".";
    mkdirSync(parent, { recursive: true });
    const db = new Database(KV_PATH, { create: true });
    db.run("pragma journal_mode = wal");
    // The table is deliberately NOT named `kv`: an install upgraded from the
    // Deno runtime keeps its old Deno KV file at the same path, and that file
    // already owns a `kv` table with an entirely different shape. A fresh name
    // makes the new store start with an empty history instead of colliding.
    db.run(
      `create table if not exists app_kv (
         ns    text    not null,
         id    text    not null,
         ts    integer not null default 0,
         value text    not null,
         primary key (ns, id)
       )`,
    );
    db.run("create index if not exists app_kv_ns_ts on app_kv (ns, ts, id)");
    this.db = db;
    log.debug(`KV store opened at ${KV_PATH}`);
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  private ensure(): Database {
    if (!this.db) throw new Error("KvStore not open — call open() first");
    return this.db;
  }

  // ── tasks ──────────────────────────────────────────────────────────────────

  async recordTask(record: TaskRecord): Promise<void> {
    const db = this.ensure();
    db.query<never, [string, number, string]>(
      `insert into app_kv (ns, id, ts, value) values ('tasks', ?, ?, ?)
       on conflict (ns, id) do update set ts = excluded.ts, value = excluded.value`,
    ).run(record.key, record.startedAt, JSON.stringify(record));
    // Keep the store bounded: drop everything older than 30 days.
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.query<never, [number]>(
      "delete from app_kv where ns = 'tasks' and ts < ?",
    ).run(cutoff);
  }

  async listTasks(limit = 100): Promise<TaskRecord[]> {
    const rows = this.ensure().query<{ value: string }, []>(
      "select value from app_kv where ns = 'tasks' order by ts asc, id asc",
    ).all();
    const records = rows.map((row) => JSON.parse(row.value) as TaskRecord);
    return records.slice(-limit).reverse();
  }

  // ── settings ───────────────────────────────────────────────────────────────

  async getSetting<T>(key: string): Promise<T | null> {
    const row = this.ensure().query<{ value: string }, [string]>(
      "select value from app_kv where ns = 'settings' and id = ?",
    ).get(key);
    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    this.ensure().query<never, [string, string]>(
      `insert into app_kv (ns, id, ts, value) values ('settings', ?, 0, ?)
       on conflict (ns, id) do update set value = excluded.value`,
    ).run(key, JSON.stringify(value));
  }

  async deleteSetting(key: string): Promise<void> {
    this.ensure().query<never, [string]>(
      "delete from app_kv where ns = 'settings' and id = ?",
    ).run(key);
  }
}

/** Singleton shared by the queue event hook and the router. */
export const kvStore = new KvStore();
