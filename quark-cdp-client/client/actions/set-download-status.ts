/// <reference lib="dom" />
import type { Page } from "playwright";
import type {
  QuarkDownloadTask,
  QuarkDownloadTaskOperation,
  QuarkDownloadTaskState,
} from "../../libs/schemas.ts";
import { QuarkDownloadTaskOperationSchema } from "../../libs/schemas.ts";
import { z } from "zod";
import { log } from "../../libs/logger.ts";
import { getHomePage, scrollListToRow } from "../page-utils.ts";
import { createAction } from "./create-action.ts";
import {
  openDownloadTasks,
  openTransportCenter,
  readDownloadTasks,
  selectDownloadTaskTab,
  TASK_ITEM_SELECTOR,
  TASK_LIST_SELECTOR,
} from "./get-download-status.ts";

export type { QuarkDownloadTaskOperation };

export interface QuarkSetDownloadStatusResult {
  success: boolean;
}

const OPERATION_SELECTOR: Record<QuarkDownloadTaskOperation, string> = {
  resume: ".task-op-resume",
  pause: ".task-op-pause",
  delete: ".task-op-delete",
};

const extractTaskName = (row: Element): string => {
  const el = row.querySelector(".task-name-text");
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
};

async function findAndOperateTask(
  homePage: Page,
  taskName: string,
  operation: QuarkDownloadTaskOperation,
): Promise<boolean> {
  const taskList = homePage.locator(TASK_LIST_SELECTOR).first();
  if (!await taskList.isVisible()) return false;

  const row = await scrollListToRow({
    page: homePage,
    scrollContainer: taskList,
    rowSelector: `${TASK_LIST_SELECTOR} ${TASK_ITEM_SELECTOR}`,
    nameInRow: extractTaskName,
    targetName: taskName,
  }).catch(() => null);

  if (!row) return false;

  await row.scrollIntoViewIfNeeded();
  const opButton = row.locator(OPERATION_SELECTOR[operation]).first();
  await opButton.waitFor({ state: "visible", timeout: 5_000 });
  await opButton.click();
  log.debug(`findAndOperateTask: operated task "${taskName}"`);
  return true;
}

/**
 * Search both transport tabs in parallel for a task with the given name.
 * Returns the tab the task lives on, or `null` if it isn't found.
 *
 * Optimisation E — the previous implementation always selected the
 * `running` tab, which made it impossible to delete a completed task.
 * Now we discover the task first and only switch tabs when necessary.
 */
async function findTaskTab(
  homePage: Page,
  taskName: string,
): Promise<QuarkDownloadTaskState | null> {
  const states: QuarkDownloadTaskState[] = ["running", "complete"];
  const results = await Promise.all(
    states.map((state) => readDownloadTasks(homePage, state)),
  );
  for (let i = 0; i < states.length; i++) {
    const found = (results[i] as QuarkDownloadTask[]).find(
      (t) => t.name === taskName,
    );
    if (found) return states[i];
  }
  return null;
}

export const setDownloadStatus = createAction(
  "setDownloadStatus",
  async (
    taskName: string,
    operation: QuarkDownloadTaskOperation,
  ): Promise<QuarkSetDownloadStatusResult> => {
    log.debug(`setDownloadStatus: task="${taskName}" op=${operation}`);

    const homePage = getHomePage();
    await homePage.bringToFront();
    await homePage.waitForLoadState("domcontentloaded");
    await openTransportCenter(homePage);
    await openDownloadTasks(homePage);

    // Optimisation E — locate the task on either tab instead of always
    // switching to `running`. This makes `delete` on completed tasks work.
    const foundOn = await findTaskTab(homePage, taskName);
    if (foundOn === null) {
      log.warn(`setDownloadStatus: task not found "${taskName}"`);
      return { success: false };
    }

    log.debug(
      `setDownloadStatus: task "${taskName}" found on tab "${foundOn}"`,
    );
    await selectDownloadTaskTab(homePage, foundOn);

    const success = await findAndOperateTask(homePage, taskName, operation);

    if (!success) {
      log.warn(
        `setDownloadStatus: task "${taskName}" disappeared from "${foundOn}" tab after discovery`,
      );
    }

    return { success };
  },
  {
    description: [
      "Operate on a single row in Quark's transport center: `resume`,",
      "`pause`, or `delete`.",
      "",
      "Locate-then-act: we search BOTH `running` and `complete` tabs for a",
      "row whose name matches `taskName` exactly, then switch to whichever",
      "tab found it before clicking. This means `delete` works on already-",
      "completed tasks too (you don't have to remember which tab they're on).",
      "",
      "Returns `{success: boolean}`. `false` means either we couldn't find",
      "a row with that name on either tab, or the row disappeared between",
      "discovery and click (e.g. another client deleted it). Use",
      "`get_download_status` with `status: \"all\"` to get an authoritative",
      "list of `taskName` values.",
      "",
      "Note: `delete` removes the task from the transport center UI; it does",
      "NOT delete the already-downloaded file from disk.",
    ].join("\n"),
    mcp: {
      name: "set_download_status",
      input: z.object({
        taskName: z.string().describe(
          "Exact `name` of the transport-center row to operate on — get it " +
            "from `get_download_status`.",
        ),
        operation: QuarkDownloadTaskOperationSchema.describe(
          "`resume` / `pause` toggle a running task; `delete` removes the " +
            "row (file on disk is untouched).",
        ),
      }),
    },
  },
);
