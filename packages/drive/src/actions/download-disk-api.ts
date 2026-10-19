import type { Page } from "playwright";
import type {
  QuarkDownloadStatus,
  QuarkDownloadTask,
} from "@quark/contract/schemas";
import { QUARK_LOCAL_DOWNLOAD_STATUS_CODES } from "@quark/contract/schemas";

/**
 * The Quark app's built-in downloader, driven from the renderer.
 *
 * `GET /download-file` only mints signed URLs. Actually writing bytes to disk
 * needs the app's own transfer engine: its CDN requests succeed where plain
 * HTTP clients from this host are rejected (`412`), and it already knows how
 * to fan a folder out into per-file transfers. We hand it one `fid` through
 * its own store action — no row is clicked, no menu is opened, and the
 * transport panel is never rendered.
 */

/** Suffix the app gives an in-flight file; renamed away on completion. */
export const QUARK_PARTIAL_DOWNLOAD_SUFFIX = ".qkdownloading";

type JsonObject = Record<string, unknown>;

// Everything below runs inside `page.evaluate`, so the helpers are inlined and
// only type aliases are shared: Playwright ships the function source alone and
// module-scope values would not exist in the renderer.

/** Shape of the renderer-side store these actions drive. */
type RendererStore = {
  dispatch: Record<string, Record<string, (...args: unknown[]) => unknown>>;
  getState: () => Record<string, unknown>;
};

/** The slice of `node:fs` these actions use inside the renderer. */
type RendererFs = {
  existsSync(path: string): boolean;
  unlinkSync(path: string): void;
  statSync(path: string): { isDirectory(): boolean };
  readdirSync(path: string): string[];
};

/** The slice of `node:path` these actions use inside the renderer. */
type RendererPath = {
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  extname(path: string): string;
};

const STATUS_NAMES: Record<number, QuarkDownloadStatus> = {
  [-1]: "error",
  [QUARK_LOCAL_DOWNLOAD_STATUS_CODES.new]: "new",
  [QUARK_LOCAL_DOWNLOAD_STATUS_CODES.init]: "init",
  [QUARK_LOCAL_DOWNLOAD_STATUS_CODES.ready]: "ready",
  [QUARK_LOCAL_DOWNLOAD_STATUS_CODES.running]: "running",
  [QUARK_LOCAL_DOWNLOAD_STATUS_CODES.pause]: "pause",
  [QUARK_LOCAL_DOWNLOAD_STATUS_CODES.cancel]: "cancel",
  [QUARK_LOCAL_DOWNLOAD_STATUS_CODES.finish]: "finish",
};

/** Decode the app's numeric task status; unknown codes become `unknown`. */
export function localDownloadStatusName(code: number): QuarkDownloadStatus {
  return STATUS_NAMES[code] ?? "unknown";
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const message = (value as JsonObject).message;
    if (typeof message === "string") return message;
    const code = (value as JsonObject).code;
    if (typeof code === "string" || typeof code === "number") {
      return String(code);
    }
  }
  return null;
}

function clampPercent(value: unknown): number {
  const number = readNumber(value) ?? 0;
  return Math.min(100, Math.max(0, number));
}

/** Project one raw app task object into the stable contract shape. */
export function mapLocalDownloadTask(raw: JsonObject): QuarkDownloadTask {
  const statusCode = readNumber(raw.status) ??
    QUARK_LOCAL_DOWNLOAD_STATUS_CODES.new;
  return {
    taskId: typeof raw.id === "string" ? raw.id : "",
    name: typeof raw.name === "string" ? raw.name : "",
    status: localDownloadStatusName(statusCode),
    statusCode,
    progressPercent: clampPercent(raw.progress),
    sizeBytes: readNumber(raw.size),
    transferredBytes: readNumber(raw.transportSize),
    speedBytesPerSec: readNumber(raw.displaySpeed) ??
      readNumber(raw.instSpeed) ?? 0,
    path: typeof raw.path === "string" ? raw.path : null,
    error: readText(raw.errorInfo),
    createdAt: readNumber(raw.createTime),
    updatedAt: readNumber(raw.updateTime),
    finishedAt: readNumber(raw.finishTime),
  };
}

export interface QuarkLocalDownloadSpec {
  fid: string;
  name: string;
  dirFid: string;
  sizeBytes: number | null;
  dir: boolean;
  savePath: string;
}

export interface QuarkLocalDownloadStart {
  taskId: string | null;
  raw: JsonObject;
}

/**
 * Ask the app for its default Downloads directory. Resolved inside the
 * renderer, so it follows the app's own home rather than the client host's.
 */
export async function resolveDownloadDirInBrowser(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const req = (window as unknown as { require: (id: string) => unknown })
      .require;
    const os = req("os") as { homedir(): string };
    const path = req("path") as { join(...parts: string[]): string };
    return path.join(os.homedir(), "Downloads");
  });
}

/**
 * Hand one file/folder to the app's downloader and return the created task id.
 * The app picks the on-disk name, so the caller only supplies the destination
 * directory (joining the stored name is the app's job).
 */
export async function startQuarkDownloadInBrowser(
  page: Page,
  spec: QuarkLocalDownloadSpec,
): Promise<QuarkLocalDownloadStart> {
  return await page.evaluate((input) => {
    const store = (window as unknown as { store: RendererStore }).store;

    const listTasks = (): Record<string, unknown>[] => {
      const download = store.getState().downloadTask as Record<string, unknown>;
      return [
        ...(download.transportTasks as Record<string, unknown>[]),
        ...(download.completeTasks as Record<string, unknown>[]),
      ];
    };
    const before = new Set(listTasks().map((task) => String(task.id)));
    const project = (
      task: Record<string, unknown>,
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(task)) {
        if (
          value === null || typeof value === "string" ||
          typeof value === "number" || typeof value === "boolean"
        ) {
          out[key] = value;
        }
      }
      return out;
    };

    store.dispatch.downloadTask.create({
      savePath: input.savePath,
      infos: [{
        fid: input.fid,
        file_name: input.name,
        dir_fid: input.dirFid,
        size: input.sizeBytes ?? 0,
        file: !input.dir,
      }],
      source: "api",
    });

    return (async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const created = listTasks().find(
          (task) =>
            !before.has(String(task.id)) &&
            String(task.fid ?? "") === input.fid,
        );
        if (created) {
          return { taskId: String(created.id), raw: project(created) };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { taskId: null, raw: {} };
    })();
  }, spec);
}

export interface QuarkLocalDownloadSnapshot {
  transport: JsonObject[];
  complete: JsonObject[];
}

/**
 * Snapshot the app's download queue as plain objects. Live task instances
 * carry methods, listeners and cycles, so only their scalar fields cross the
 * CDP boundary; everything else stays in the renderer.
 */
export async function readQuarkDownloadQueueInBrowser(
  page: Page,
): Promise<QuarkLocalDownloadSnapshot> {
  return await page.evaluate(() => {
    const store = (window as unknown as {
      store: { getState: () => Record<string, unknown> };
    }).store;
    const download = store.getState().downloadTask as Record<string, unknown>;
    const project = (tasks: unknown): Record<string, unknown>[] =>
      (Array.isArray(tasks) ? tasks : []).map((task) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(task as object)) {
          if (
            value === null || typeof value === "string" ||
            typeof value === "number" || typeof value === "boolean"
          ) {
            out[key] = value;
          } else if (value !== null && typeof value === "object") {
            try {
              JSON.stringify(value);
              out[key] = value;
            } catch {
              // Skip cycles and non-serializable state (entities, dbos, deps).
            }
          }
        }
        return out;
      });
    return {
      transport: project(download.transportTasks),
      complete: project(download.completeTasks),
    };
  });
}

export interface QuarkLocalDownloadControl {
  taskIds: string[];
  operation: "pause" | "resume" | "cancel";
}

export interface QuarkLocalDownloadControlResult {
  applied: string[];
  removedPartials: string[];
  raw: JsonObject;
}

/**
 * Apply `pause`/`resume`/`cancel` to local tasks by id. `cancel` stops the
 * transfer, drops it from the app's list, and deletes the `.qkdownloading`
 * partials it left on disk — nothing else is ever removed.
 */
export async function controlQuarkDownloadInBrowser(
  page: Page,
  input: QuarkLocalDownloadControl,
): Promise<QuarkLocalDownloadControlResult> {
  return await page.evaluate(async (control) => {
    const store = (window as unknown as { store: RendererStore }).store;
    const fs = (window as unknown as { require: (id: string) => RendererFs })
      .require("fs");
    const pathMod =
      (window as unknown as { require: (id: string) => RendererPath })
        .require("path");
    const suffix = ".qkdownloading";

    const findTask = (taskId: string): Record<string, unknown> | undefined => {
      const download = store.getState().downloadTask as Record<string, unknown>;
      const all = [
        ...(download.transportTasks as Record<string, unknown>[]),
        ...(download.completeTasks as Record<string, unknown>[]),
      ];
      return all.find((task) => String(task.id) === taskId);
    };

    // The app writes an in-flight file as `<stem>-<hash><ext>.qkdownloading`,
    // so the partial is matched by directory + stem, never by exact name.
    const removedPaths: string[] = [];
    const tryUnlink = (file: string): void => {
      try {
        if (!fs.existsSync(file)) return;
        fs.unlinkSync(file);
        removedPaths.push(file);
      } catch {
        // A locked or already-gone partial must not fail the whole call.
      }
    };
    const scanForPartials = (dir: string, stem: string | null): void => {
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const full = pathMod.join(dir, name);
        if (name.endsWith(suffix)) {
          if (stem === null || name.startsWith(stem)) tryUnlink(full);
          continue;
        }
        try {
          if (fs.statSync(full).isDirectory()) scanForPartials(full, stem);
        } catch {
          // Skip anything we cannot inspect.
        }
      }
    };
    const removePartials = (target: unknown): string[] => {
      if (typeof target !== "string" || target === "") return [];
      const start = removedPaths.length;
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(target).isDirectory();
      } catch {
        // The destination may not exist yet; the exact-name probe below still
        // covers a partial written next to it.
      }
      if (isDirectory) {
        scanForPartials(target, null);
      } else {
        tryUnlink(`${target}${suffix}`);
        const base = pathMod.basename(target);
        const ext = pathMod.extname(base);
        const stem = ext === ""
          ? base
          : base.slice(0, base.length - ext.length);
        scanForPartials(pathMod.dirname(target), stem);
      }
      return removedPaths.slice(start);
    };

    const applied: string[] = [];
    const removedPartials: string[] = [];
    for (const taskId of control.taskIds) {
      const task = findTask(taskId);
      if (!task) continue;
      const status = Number(task.status);
      if (control.operation === "pause") {
        store.dispatch.downloadTask.pauseOne(task);
      } else if (control.operation === "resume") {
        store.dispatch.downloadTask.resumeOne(task);
      } else {
        const finished = status === 6;
        const fromTab = finished ? "complete" : "transport";
        if (!finished) {
          try {
            store.dispatch.downloadTask.pauseOne(task);
          } catch {
            // Pausing is best effort; removal below is authoritative.
          }
        }
        try {
          store.dispatch.downloadTask.removeOne({ task, fromTab });
        } catch {
          // Already gone.
        }
        removedPartials.push(...removePartials(task.path));
      }
      applied.push(taskId);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { applied, removedPartials, raw: {} };
  }, input);
}
