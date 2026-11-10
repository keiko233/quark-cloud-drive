import type {
  QuarkDownloadControlResult,
  QuarkDownloadOperation,
  QuarkDownloadQueue,
  QuarkDownloadTask,
} from "@quark/contract/schemas";
import { log } from "@quark/config";
import { getQuarkPage } from "./quark-session.ts";
import {
  controlQuarkDownloadInBrowser,
  hasActiveQuarkDownloadsInBrowser,
  mapLocalDownloadTask,
  readQuarkDownloadQueueInBrowser,
} from "../browser/download-engine.ts";

export interface ListDownloadsOptions {
  taskId?: string;
  raw?: boolean;
}

export interface ControlDownloadsInput {
  taskIds: string[];
  operation: QuarkDownloadOperation;
  raw?: boolean;
}

/**
 * Read the app's local download queue. Only root tasks are returned: a folder
 * download fans out into per-file children inside the app, and those would
 * otherwise drown the queue the caller asked about.
 */
export async function listDownloads(
  options: ListDownloadsOptions = {},
): Promise<QuarkDownloadQueue> {
  const page = await getQuarkPage();
  const snapshot = await readQuarkDownloadQueueInBrowser(page);

  const all = [...snapshot.transport, ...snapshot.complete];
  const ids = new Set(all.map((task) => String(task.id ?? "")));
  const roots = all.filter((task) => {
    const parent = String(task.pid ?? "");
    return parent === "" || !ids.has(parent);
  });

  const tasks: QuarkDownloadTask[] = roots.map(mapLocalDownloadTask)
    .filter((task) => task.taskId && (options.taskId === undefined || task.taskId === options.taskId));
  const counts = {
    total: tasks.length,
    running: tasks.filter((task) => task.status === "running").length,
    paused: tasks.filter((task) => task.status === "pause").length,
    finished: tasks.filter((task) => task.status === "finish").length,
    failed: tasks.filter((task) => task.status === "error").length,
  };
  log.debug(
    `listDownloads: ${counts.total} task(s), ${counts.running} running`,
  );

  return {
    tasks,
    counts,
    ...(options.raw === true
      ? { raw: { transport: snapshot.transport, complete: snapshot.complete } }
      : {}),
  };
}

/** Pause, resume or cancel local downloads started by POST /downloads. */
export async function controlDownloads(
  input: ControlDownloadsInput,
): Promise<QuarkDownloadControlResult> {
  const taskIds = [...new Set(input.taskIds.map((taskId) => taskId.trim()).filter(Boolean))];
  if (taskIds.length === 0) {
    throw new Error("controlDownloads: taskIds is required");
  }

  const page = await getQuarkPage();
  const result = await controlQuarkDownloadInBrowser(page, {
    taskIds,
    operation: input.operation,
  });
  log.debug(
    `controlDownloads: ${input.operation} ${result.applied.length} task(s), ` +
      `${result.removedPartials.length} partial(s) removed`,
  );

  return {
    success: result.applied.length === taskIds.length,
    taskIds: result.applied,
    operation: input.operation,
    removedPartials: result.removedPartials,
    ...(input.raw === true ? { raw: result.raw } : {}),
  };
}

/** Check root and child transfers before the runtime goes idle. */
export async function hasActiveDownloads(): Promise<boolean> {
  return hasActiveQuarkDownloadsInBrowser(await getQuarkPage());
}
