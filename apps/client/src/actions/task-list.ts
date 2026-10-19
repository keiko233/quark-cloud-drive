import type {
  QuarkTaskList,
  QuarkTaskStatusFilter,
} from "@quark/contract/schemas";
import { log } from "../logger.ts";
import { getQuarkPage } from "./browser-session.ts";
import {
  fetchQuarkTaskCountsInBrowser,
  fetchQuarkTaskPageInBrowser,
} from "./task-api.ts";

export interface TaskListInput {
  status?: QuarkTaskStatusFilter;
  /** CSV of task-type names (`offline_download`) or numeric codes. */
  type?: string;
  size?: number;
  cursor?: string;
  raw?: boolean;
}

/**
 * Read Quark's cloud task list plus per-status counts. Both come from the
 * JSON task API, so the transport panel is never opened and no DOM is read.
 */
export async function taskList(
  input: TaskListInput = {},
): Promise<QuarkTaskList> {
  const includeRaw = input.raw === true;
  const page = await getQuarkPage();

  const [listPage, counts] = await Promise.all([
    fetchQuarkTaskPageInBrowser(page, {
      status: input.status,
      type: input.type,
      size: input.size,
      cursor: input.cursor,
    }),
    fetchQuarkTaskCountsInBrowser(page, input.type),
  ]);

  log.debug(
    `taskList: ${listPage.tasks.length} task(s), ${counts.counts.total} counted`,
  );

  return {
    tasks: listPage.tasks,
    counts: counts.counts,
    cursor: listPage.cursor,
    ...(includeRaw
      ? {
        raw: {
          list: listPage.entries.map((entry) => entry.raw),
          listMetadata: listPage.metadata,
          count: counts.raw,
        },
      }
      : {}),
  };
}
