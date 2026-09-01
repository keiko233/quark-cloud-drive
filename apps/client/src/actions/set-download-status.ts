/// <reference lib="dom" />
import type { Page } from "playwright";
import type {
  QuarkDownloadTaskOperation,
  QuarkDownloadTaskState,
} from "@quark/contract/schemas";
import { log } from "../logger.ts";
import { getOperationQueue } from "../browser/context.ts";
import { getHomePage, scrollListToRow } from "../browser/page-utils.ts";
import { downloadStatusCache } from "../cache/caches.ts";
import {
  openDownloadTasks,
  openTransportCenter,
  readDownloadStatusRaw,
  selectDownloadTaskTab,
  TASK_ITEM_SELECTOR,
  TASK_LIST_SELECTOR,
} from "./download-status.ts";

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
 * Locate a task on either transport tab by name, using the raw (un-queued)
 * reader to avoid re-entering the single-slot queue.
 */
async function findTaskTab(
  taskName: string,
): Promise<QuarkDownloadTaskState | null> {
  const states: QuarkDownloadTaskState[] = ["running", "complete"];
  for (const state of states) {
    const tasks = await readDownloadStatusRaw(state);
    const found = tasks.tasks.find((t) => t.name === taskName);
    if (found) return state;
  }
  return null;
}

/** Queued public entry point (used by the router). */
export function setDownloadStatus(
  taskName: string,
  operation: QuarkDownloadTaskOperation,
): Promise<QuarkSetDownloadStatusResult> {
  return getOperationQueue().run(
    "setDownloadStatus",
    { key: `setDownloadStatus:${taskName}`, priority: 1 },
    async () => {
      const homePage = getHomePage();
      await homePage.bringToFront();
      await homePage.waitForLoadState("domcontentloaded");
      await openTransportCenter(homePage);
      await openDownloadTasks(homePage);

      const foundOn = await findTaskTab(taskName);
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

      // A state change invalidates every download-status read.
      downloadStatusCache.clear();
      return { success };
    },
  );
}
