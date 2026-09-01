import type { Page } from "playwright";
import type {
  QuarkDownloadStatus,
  QuarkDownloadStatusMode,
  QuarkDownloadTask,
  QuarkDownloadTaskState,
} from "@quark/contract/schemas";
import { log } from "../logger.ts";
import { getOperationQueue } from "../browser/context.ts";
import {
  getHomePage,
  getPageRoute,
  scrollAndCollect,
} from "../browser/page-utils.ts";
import { downloadStatusCache } from "../cache/caches.ts";

const DOWNLOAD_TEXT = "下载";
const USER_DIVIDER_SELECTOR = "div.user-divider";
const TRANSPORT_TASK_BOX_SELECTOR = "div.transport-task-box";
const TRANSPORT_ROUTE = "/transport";
const TABS_NAV_SELECTOR = "div.ant-tabs-nav-list";
const TASK_LIST_SELECTOR = "div.task-list-container";
const TASK_ITEM_SELECTOR = "div.task-item";
const TASK_PANEL_READY_TIMEOUT = 3_000;

export {
  TABS_NAV_SELECTOR,
  TASK_ITEM_SELECTOR,
  TASK_LIST_SELECTOR,
  TRANSPORT_TASK_BOX_SELECTOR,
};

export async function openTransportCenter(homePage: Page): Promise<void> {
  if (getPageRoute(homePage).startsWith(TRANSPORT_ROUTE)) {
    log.trace(
      "openTransportCenter: already on transport route, skipping click",
    );
    return;
  }

  log.debug("openTransportCenter: opening transport center");
  const userDivider = homePage.locator(USER_DIVIDER_SELECTOR).first();
  await userDivider.waitFor({ state: "visible", timeout: 10_000 });

  const clicked = await userDivider.evaluate((element) => {
    const transportItem = element.children.item(1)?.querySelector("div");
    transportItem?.click();
    return Boolean(transportItem);
  });

  if (!clicked) throw new Error("Transport nav item not found");

  await homePage.locator(TRANSPORT_TASK_BOX_SELECTOR).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });

  log.trace("openTransportCenter: transport box visible");
}

export async function openDownloadTasks(homePage: Page): Promise<void> {
  log.trace("openDownloadTasks: clicking download task box");

  const clicked = await homePage.locator(TRANSPORT_TASK_BOX_SELECTOR)
    .evaluateAll((boxes, downloadText) => {
      const taskBox = boxes.find((box) => {
        const title = box.querySelector("div.transport-task-title")
          ?.textContent ?? "";
        return title.replace(/\s+/g, " ").trim() === downloadText;
      });
      (taskBox as { click?: () => void } | undefined)?.click?.();
      return Boolean(taskBox);
    }, DOWNLOAD_TEXT);

  if (!clicked) throw new Error("Download task box not found");

  await homePage.locator(TABS_NAV_SELECTOR).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
}

export async function selectDownloadTaskTab(
  homePage: Page,
  state: QuarkDownloadTaskState,
): Promise<void> {
  const tab = homePage.locator(
    `${TABS_NAV_SELECTOR} div.ant-tabs-tab[data-node-key="${state}"]`,
  ).first();

  await tab.waitFor({ state: "attached", timeout: 10_000 });

  const isActive = await tab.evaluate(
    (el) => el.classList.contains("ant-tabs-tab-active"),
  ).catch(() => false);

  if (isActive) {
    log.trace(`selectDownloadTaskTab: "${state}" already active, skipping`);
    return;
  }

  log.debug(`selectDownloadTaskTab: selecting "${state}" tab`);
  await tab.evaluate((element) => {
    (element as { click: () => void }).click();
  });

  await waitForTaskPanelSettled(homePage);
}

async function waitForTaskPanelSettled(homePage: Page): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < TASK_PANEL_READY_TIMEOUT) {
    if (await homePage.locator(TASK_LIST_SELECTOR).first().isVisible()) {
      await homePage.waitForTimeout(300);
      return;
    }
    await homePage.waitForTimeout(100);
  }
}

async function readCurrentTabTasks(
  homePage: Page,
  state: QuarkDownloadTaskState,
): Promise<QuarkDownloadTask[]> {
  return await homePage.locator(`${TASK_LIST_SELECTOR} ${TASK_ITEM_SELECTOR}`)
    .evaluateAll((items, taskState) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const parseSize = (value: string): { size: string; progress: string } => {
        const match = value.match(/^(.*?)\s*\((.*?)\)$/);
        if (!match) return { size: value, progress: "" };
        return {
          size: match[1]?.trim() ?? "",
          progress: match[2]?.trim() ?? "",
        };
      };

      return items.map((item) => {
        const sizeInfo = parseSize(
          normalize(item.querySelector(".task-size")?.textContent ?? ""),
        );
        const status = item.querySelector(".task-status");

        return {
          state: taskState as "running" | "complete",
          name: normalize(item.querySelector(".task-name-text")?.textContent),
          size: sizeInfo.size,
          progress: sizeInfo.progress,
          speed: taskState === "running"
            ? normalize(status?.textContent ?? "")
            : "",
          remaining: taskState === "running"
            ? normalize(item.querySelector(".time-remaining")?.textContent)
            : "",
          completedAt: taskState === "complete"
            ? normalize(status?.getAttribute("title") ?? status?.textContent)
            : "",
        };
      }).filter((task) => task.name.length > 0);
    }, state);
}

function getDownloadTaskKey(task: QuarkDownloadTask): string {
  return [task.state, task.name, task.size, task.completedAt].join(" ");
}

async function readDownloadTasks(
  homePage: Page,
  state: QuarkDownloadTaskState,
  onProgress?: (seen: number) => void,
): Promise<QuarkDownloadTask[]> {
  await selectDownloadTaskTab(homePage, state);

  const taskList = homePage.locator(TASK_LIST_SELECTOR).first();
  if (!await taskList.isVisible()) return [];

  return scrollAndCollect<QuarkDownloadTask>({
    page: homePage,
    scrollContainer: taskList,
    readVisible: () => readCurrentTabTasks(homePage, state),
    getKey: getDownloadTaskKey,
    label: `downloadTasks-${state}`,
    onProgress,
  });
}

/**
 * Raw (un-queued) read of Quark's transport center. Used internally by other
 * actions so they don't re-enter the single-slot queue and deadlock.
 */
export async function readDownloadStatusRaw(
  mode: QuarkDownloadStatusMode = "running",
): Promise<QuarkDownloadStatus> {
  const homePage = getHomePage();
  await homePage.bringToFront();
  await homePage.waitForLoadState("domcontentloaded");
  await openTransportCenter(homePage);
  await openDownloadTasks(homePage);

  const normalizedMode = (mode ?? "running") as QuarkDownloadStatusMode;
  const states: QuarkDownloadTaskState[] = normalizedMode === "all"
    ? ["running", "complete"]
    : [normalizedMode === "complete" ? "complete" : "running"];

  const tasks: QuarkDownloadTask[] = [];
  for (const state of states) {
    tasks.push(...await readDownloadTasks(homePage, state));
  }

  log.debug(`downloadStatus: ${tasks.length} tasks`);
  return { tasks };
}

/**
 * Queued public entry point (used by the router). Cached for 5s per mode.
 */
export function downloadStatus(
  mode: QuarkDownloadStatusMode = "running",
): Promise<QuarkDownloadStatus> {
  const cacheKey = mode ?? "running";
  const cached = downloadStatusCache.get(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);

  return getOperationQueue().run(
    "downloadStatus",
    { key: `downloadStatus:${cacheKey}` },
    async () => {
      const result = await readDownloadStatusRaw(mode);
      downloadStatusCache.set(cacheKey, result);
      return result;
    },
  );
}
