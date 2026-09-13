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
  selectTopNavigation,
} from "../browser/page-utils.ts";
import { downloadStatusCache } from "../cache/caches.ts";
import {
  navigateToPath,
  readBreadcrumbPath,
  resetToHome,
} from "./list-file.ts";

const DOWNLOAD_TEXT = "下载";
const TRANSPORT_TASK_BOX_SELECTOR = "div.transport-task-box";
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
  log.debug("openTransportCenter: opening transport center");
  await selectTopNavigation(homePage, "传输");

  await homePage.locator(TRANSPORT_TASK_BOX_SELECTOR).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });

  log.trace("openTransportCenter: transport box visible");
}

export async function openDownloadTasks(homePage: Page): Promise<void> {
  log.trace("openDownloadTasks: clicking download task box");

  const taskBox = homePage.locator(TRANSPORT_TASK_BOX_SELECTOR)
    .filter({ hasText: DOWNLOAD_TEXT })
    .first();
  await taskBox.waitFor({ state: "visible", timeout: 10_000 });

  const className = await taskBox.getAttribute("class") ?? "";
  if (!className.split(/\s+/).includes("transport-task-box-selected")) {
    await taskBox.dispatchEvent("click");
  } else {
    log.trace("openDownloadTasks: download task box already selected");
  }

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
  options: { restorePage?: boolean } = {},
): Promise<QuarkDownloadStatus> {
  const homePage = getHomePage();
  await homePage.bringToFront();
  await homePage.waitForLoadState("domcontentloaded");

  const restorePage = options.restorePage === true;
  const wasOnFileList = restorePage && getPageRoute(homePage).startsWith(
    "/list",
  );
  const restorePath = wasOnFileList
    ? await readBreadcrumbPath(homePage).catch(() => null)
    : null;

  try {
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
  } finally {
    if (wasOnFileList) {
      await resetToHome(homePage).catch((error) =>
        log.warn(
          `downloadStatus: failed to restore 首页: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      );
      if (restorePath && restorePath.length > 0) {
        await navigateToPath(homePage, restorePath.join("/")).catch((error) =>
          log.warn(
            `downloadStatus: failed to restore path: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        );
      }
    }
  }
}

/**
 * Read the live running-task count without navigating to 传输. This is used
 * by the idle monitor so background checks do not steal 首页's scroll state.
 * `null` means this Quark build does not expose the native manager API and
 * callers should fall back to the rendered transport panel.
 */
export async function readRunningDownloadCountRaw(): Promise<number | null> {
  const homePage = getHomePage();
  await homePage.bringToFront();
  await homePage.waitForLoadState("domcontentloaded");

  return await homePage.evaluate(async () => {
    type DownloadManager = {
      dboDir?: { getCount?: () => Promise<unknown> };
    };
    const manager = (window as unknown as { downloadManager?: DownloadManager })
      .downloadManager;
    const dboDir = manager?.dboDir;
    const getCount = dboDir?.getCount;
    if (typeof getCount !== "function") return null;

    const count = await getCount.call(dboDir);
    return typeof count === "number" ? count : null;
  });
}

/**
 * Read Quark's native task index without opening 传输. The rendered transport
 * page is a shared view and navigating there steals the file-list selection,
 * so download actions use this index for duplicate checks instead.
 */
export async function readDownloadTaskNamesRaw(): Promise<string[] | null> {
  const homePage = getHomePage();
  await homePage.bringToFront();
  await homePage.waitForLoadState("domcontentloaded");

  try {
    return await homePage.evaluate(async () => {
      type NativeTask = {
        name?: unknown;
        path?: unknown;
        status?: unknown;
      };
      type TaskRecord = {
        add?: unknown;
        sub?: unknown;
      };
      type DownloadManager = {
        dboDir?: { getTasks?: () => Promise<unknown> };
      };

      const manager =
        (window as unknown as { downloadManager?: DownloadManager })
          .downloadManager;
      const dboDir = manager?.dboDir;
      const getTasks = dboDir?.getTasks;
      if (typeof getTasks !== "function") return null;

      const records = await getTasks.call(dboDir);
      if (!Array.isArray(records)) return [];

      const names = new Set<string>();
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) visit(item);
          return;
        }
        if (!value || typeof value !== "object") return;

        const task = value as NativeTask;
        if (
          typeof task.name === "string" &&
          (typeof task.path === "string" || task.status !== undefined)
        ) {
          const name = task.name.replace(/\s+/g, " ").trim();
          if (name) names.add(name);
        }

        const record = value as TaskRecord;
        visit(record.add);
        visit(record.sub);
      };

      visit(records);
      return [...names];
    });
  } catch (error) {
    log.warn(
      `readDownloadTaskNamesRaw: native task index unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
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
