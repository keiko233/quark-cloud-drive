import type {
  QuarkDownloadControlResult,
  QuarkDownloadOperation,
  QuarkDownloadQueue,
  QuarkDownloadTask,
} from "@quark/contract/schemas";
import { log } from "../logger.ts";
import { getQuarkPage } from "./browser-session.ts";
import {
  controlQuarkDownloadInBrowser,
  mapLocalDownloadTask,
  readQuarkDownloadQueueInBrowser,
} from "./download-disk-api.ts";

export interface DownloadTaskListOptions {
  raw?: boolean;
}

export interface UpdateDownloadTaskInput {
  taskIds: string[];
  operation: QuarkDownloadOperation;
  raw?: boolean;
}

/**
 * Read the app's local download queue. Only root tasks are returned: a folder
 * download fans out into per-file children inside the app, and those would
 * otherwise drown the queue the caller asked about.
 */
export async function downloadTaskList(
  options: DownloadTaskListOptions = {},
): Promise<QuarkDownloadQueue> {
  const page = await getQuarkPage();
  const snapshot = await readQuarkDownloadQueueInBrowser(page);

  const all = [...snapshot.transport, ...snapshot.complete];
  const ids = new Set(all.map((task) => String(task.id ?? "")));
  const roots = all.filter((task) => {
    const parent = String(task.pid ?? "");
    return parent === "" || !ids.has(parent);
  });

  const tasks: QuarkDownloadTask[] = roots.map(mapLocalDownloadTask);
  const counts = {
    total: tasks.length,
    running: tasks.filter((task) => task.status === "running").length,
    paused: tasks.filter((task) => task.status === "pause").length,
    finished: tasks.filter((task) => task.status === "finish").length,
    failed: tasks.filter((task) => task.status === "error").length,
  };
  log.debug(
    `downloadTaskList: ${counts.total} task(s), ${counts.running} running`,
  );

  return {
    tasks,
    counts,
    ...(options.raw === true
      ? { raw: { transport: snapshot.transport, complete: snapshot.complete } }
      : {}),
  };
}

/** Pause, resume or cancel local downloads started by POST /download-file. */
export async function updateDownloadTask(
  input: UpdateDownloadTaskInput,
): Promise<QuarkDownloadControlResult> {
  const taskIds = input.taskIds.map((taskId) => taskId.trim()).filter(
    (taskId) => taskId !== "",
  );
  if (taskIds.length === 0) {
    throw new Error("updateDownloadTask: taskIds is required");
  }

  const page = await getQuarkPage();
  const result = await controlQuarkDownloadInBrowser(page, {
    taskIds,
    operation: input.operation,
  });
  log.debug(
    `updateDownloadTask: ${input.operation} ${result.applied.length} task(s), ` +
      `${result.removedPartials.length} partial(s) removed`,
  );

  return {
    success: true,
    taskIds: result.applied,
    operation: input.operation,
    removedPartials: result.removedPartials,
    ...(input.raw === true ? { raw: result.raw } : {}),
  };
}
