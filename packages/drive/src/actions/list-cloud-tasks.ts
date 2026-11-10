import type {
  QuarkTaskList,
  QuarkTaskStatusFilter,
} from "@quark/contract/schemas";
import { log } from "@quark/config";
import { getQuarkTransport } from "./quark-session.ts";
import {
  fetchQuarkTaskCounts,
  fetchQuarkTaskPage,
} from "../api/task-api.ts";

export interface ListCloudTasksInput {
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
export async function listCloudTasks(
  input: ListCloudTasksInput = {},
): Promise<QuarkTaskList> {
  const includeRaw = input.raw === true;
  const transport = getQuarkTransport();

  const [listPage, counts] = await Promise.all([
    fetchQuarkTaskPage(transport, {
      status: input.status,
      type: input.type,
      size: input.size,
      cursor: input.cursor,
    }),
    fetchQuarkTaskCounts(transport, input.type),
  ]);

  log.debug(
    `listCloudTasks: ${listPage.tasks.length} task(s), ${counts.counts.total} counted`,
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
