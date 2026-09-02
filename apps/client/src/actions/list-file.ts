/// <reference lib="dom" />
import type { Page } from "playwright";
import type {
  FileListStreamEvent,
  QuarkFileList,
  QuarkFileListItem,
} from "@quark/contract/schemas";
import { log } from "../logger.ts";
import { getOperationQueue } from "../browser/context.ts";
import { Channel } from "../queue/operation-queue.ts";
import {
  getHomePage,
  getPageRoute,
  readNamesSnapshot,
  scrollAndCollect,
  scrollListToRow,
  selectTopNavigation,
} from "../browser/page-utils.ts";

export const BREADCRUMB_SELECTOR = "#quark-cloud-drive-list-all-breadcrumb";
export const TABLE_ROW_SELECTOR = "tbody.ant-table-tbody > tr";
export const TABLE_SCROLL_SELECTOR = "div.ant-table-body";

const HOME_TEXT = "首页";
const ROOT_PATH_TEXT = "文件";
const FILE_LIST_READY_TIMEOUT = 10_000;
const FILE_LIST_ROUTE = "/list";
const FILE_LIST_EMPTY_SELECTOR =
  ".empty-drop, .empty-box, [class*='empty-content'], [class*='empty-text']";

type NavPlan =
  | { action: "none" }
  | { action: "navigate"; segments: string[] }
  | { action: "reset"; segments: string[] };

export function planNavigation(current: string[], target: string[]): NavPlan {
  if (target.length === 0) {
    return current.length === 0
      ? { action: "none" }
      : { action: "reset", segments: [] };
  }
  if (
    current.length <= target.length &&
    current.every((seg, i) => seg === target[i])
  ) {
    const remaining = target.slice(current.length);
    return remaining.length === 0
      ? { action: "none" }
      : { action: "navigate", segments: remaining };
  }
  return { action: "reset", segments: target };
}

function isHomeNavSelected(homePage: Page): boolean {
  return getPageRoute(homePage).startsWith(FILE_LIST_ROUTE);
}

export async function resetToHome(homePage: Page): Promise<void> {
  const onListRoute = getPageRoute(homePage).startsWith(FILE_LIST_ROUTE);

  const isAtRoot = onListRoute &&
    await homePage.locator(BREADCRUMB_SELECTOR).first()
      .isVisible()
      .then(async (visible) => {
        if (!visible) return false;
        const path = await readBreadcrumbPath(homePage);
        return path.length === 0;
      })
      .catch(() => false);

  if (isAtRoot) {
    log.trace("resetToHome: already at root, skipping navigation");
    await waitForFileListReady(homePage);
    return;
  }

  log.debug("resetToHome: navigating to root");
  await selectTopNavigation(homePage, "首页", { force: true });

  await waitForRootBreadcrumb(homePage);
  await waitForFileListReady(homePage);
}

async function waitForRootBreadcrumb(homePage: Page): Promise<void> {
  await homePage.locator(BREADCRUMB_SELECTOR).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const pathSegments = await readBreadcrumbPath(homePage);
    if (pathSegments.length === 0) return;
    await homePage.waitForTimeout(100);
  }

  throw new Error("Timed out waiting for home breadcrumb");
}

export async function navigateToPath(
  homePage: Page,
  path: string,
): Promise<void> {
  const segments = parsePathSegments(path);
  log.debug(`navigateToPath: path="${path}" segments=${segments.length}`);

  for (const segment of segments) {
    await openPathSegment(homePage, segment);
    await waitForFileListReady(homePage);
  }
}

async function openPathSegment(homePage: Page, segment: string): Promise<void> {
  const row = await scrollListToRow({
    page: homePage,
    scrollContainer: getScrollContainer(homePage),
    rowSelector: TABLE_ROW_SELECTOR,
    nameInRow: extractFileListRowName,
    targetName: segment,
  });

  await row.scrollIntoViewIfNeeded();
  await row.evaluate((el) => {
    const ctor = (el.ownerDocument.defaultView as unknown as {
      MouseEvent: new (
        type: string,
        eventInitDict?: {
          bubbles?: boolean;
          cancelable?: boolean;
          view?: unknown;
        },
      ) => Event;
    }).MouseEvent;
    el.dispatchEvent(
      new ctor("dblclick", {
        bubbles: true,
        cancelable: true,
        view: el.ownerDocument.defaultView,
      }),
    );
  });

  await homePage.locator(BREADCRUMB_SELECTOR)
    .filter({ hasText: segment })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });

  log.trace(`openPathSegment: opened "${segment}"`);
}

/**
 * The single source of truth for "what is this file list row called?".
 * Strips the `all-file-list-mode-tips` badges (e.g. "NEW", "限时").
 */
export function extractFileListRowName(row: Element): string {
  const el = row.querySelector("td.td-file.file-name .filename-text");
  if (!el) return "";
  const cloned = el.cloneNode(true) as Element;
  cloned.querySelectorAll(".all-file-list-mode-tips").forEach((tag) =>
    tag.remove()
  );
  return (cloned.textContent ?? "").replace(/\s+/g, " ").trim();
}

export async function waitForFileListReady(homePage: Page): Promise<void> {
  log.trace("waitForFileListReady: waiting");

  await homePage.locator(BREADCRUMB_SELECTOR).first().waitFor({
    state: "visible",
    timeout: FILE_LIST_READY_TIMEOUT,
  });

  // Quark does not render a table or scroll container for an empty folder.
  // Waiting for the old table-only structure made valid empty directories
  // look like a Playwright timeout. Accept either the populated table or the
  // empty-state view as the terminal ready state.
  const table = homePage.locator("tbody.ant-table-tbody").first();
  const emptyState = homePage.locator(FILE_LIST_EMPTY_SELECTOR);
  const startedAt = Date.now();
  let ready = false;
  while (Date.now() - startedAt < FILE_LIST_READY_TIMEOUT) {
    if (await table.isVisible().catch(() => false)) {
      ready = true;
      break;
    }
    const emptyCount = await emptyState.count();
    for (let i = 0; i < emptyCount; i++) {
      if (await emptyState.nth(i).isVisible().catch(() => false)) {
        ready = true;
        break;
      }
    }
    if (ready) break;
    await homePage.waitForTimeout(100);
  }

  if (!ready) {
    throw new Error(
      `Timed out waiting for file list content or empty state after ${FILE_LIST_READY_TIMEOUT}ms`,
    );
  }

  if (!await table.isVisible().catch(() => false)) {
    log.trace("waitForFileListReady: empty folder");
    return;
  }

  await getScrollContainer(homePage).waitFor({
    state: "visible",
    timeout: FILE_LIST_READY_TIMEOUT,
  });
  await homePage.waitForLoadState("networkidle", { timeout: 3_000 })
    .catch(() => undefined);
  await readNamesSnapshot(
    homePage,
    TABLE_ROW_SELECTOR,
    extractFileListRowName,
  );

  log.trace("waitForFileListReady: ready");
}

export function getScrollContainer(homePage: Page) {
  return homePage.locator(TABLE_SCROLL_SELECTOR).first();
}

async function readVisibleRows(homePage: Page): Promise<QuarkFileListItem[]> {
  return await homePage.locator(TABLE_ROW_SELECTOR)
    .evaluateAll(
      (rows, fnSrc) => {
        // eslint-disable-next-line no-new-func
        const extractName = new Function("el", `return (${fnSrc})(el);`) as (
          el: Element,
        ) => string;
        const getCellText = (row: Element, selector: string): string => {
          const cell = row.querySelector(selector);
          return (cell?.textContent ?? "").replace(/\s+/g, " ").trim();
        };
        return rows.map((row) => ({
          name: extractName(row),
          size: getCellText(row, "td.ant-table-cell.td-file.td-file-size"),
          type: getCellText(
            row,
            "td.ant-table-cell.td-file:not(.file-name):not(.td-file-size):not(.td-file-time)",
          ),
          updatedAt: getCellText(
            row,
            "td.ant-table-cell.td-file.td-file-time",
          ),
        })).filter((item) => item.name.length > 0);
      },
      extractFileListRowName.toString(),
    );
}

async function readBreadcrumbPath(homePage: Page): Promise<string[]> {
  return await homePage.locator(BREADCRUMB_SELECTOR).first().evaluate((
    root,
    rootPathText,
  ) => {
    const normalize = (value: string | null): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    return [...root.querySelectorAll(".bcrumb-filename")]
      .map((item) => normalize((item.querySelector("a") ?? item).textContent))
      .filter(Boolean)
      .filter((text) => text !== rootPathText);
  }, ROOT_PATH_TEXT);
}

export { readBreadcrumbPath };

export async function isAtPath(
  homePage: Page,
  targetSegments: string[],
): Promise<boolean> {
  if (!getPageRoute(homePage).startsWith(FILE_LIST_ROUTE)) return false;
  let current: string[] | null = null;
  try {
    current = await readBreadcrumbPath(homePage);
  } catch {
    return false;
  }
  if (current === null) return false;
  if (current.length > targetSegments.length) return false;
  return current.every((seg, i) => seg === targetSegments[i]);
}

export function normalizeFileListText(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function listFileItemKey(item: QuarkFileListItem): string {
  return [item.name, item.size, item.type, item.updatedAt].join("\u0000");
}

export function parsePathSegments(path: string): string[] {
  return path
    .split(/[\\/]/)
    .map((segment) => normalizeFileListText(segment))
    .filter(Boolean)
    .filter((segment) => segment !== HOME_TEXT);
}

/**
 * Queued streaming entry point. Yields `collecting` progress while the
 * virtual list is scrolled, then returns the full `{path, items}` list.
 */
export function listFile(
  path?: string,
): Promise<AsyncGenerator<FileListStreamEvent, QuarkFileList>> {
  const cacheKey = path ?? "";

  return getOperationQueue().runStreaming(
    "listFile",
    { key: `fileList:${cacheKey}` },
    async function* () {
      log.debug(`listFile: path=${cacheKey || "root"}`);

      const homePage = getHomePage();
      await homePage.bringToFront();
      await homePage.waitForLoadState("domcontentloaded");

      yield {
        type: "status",
        message: `当前页面 ${await describeCurrentPage(homePage)}`,
      };

      const targetSegments = cacheKey ? parsePathSegments(cacheKey) : [];
      const homeNavActive = isHomeNavSelected(homePage);

      if (homeNavActive) {
        const currentPath = await readBreadcrumbPath(homePage).catch(() =>
          null
        );
        if (currentPath !== null) {
          const plan = planNavigation(currentPath, targetSegments);
          log.debug(
            `listFile: nav=[home] current=[${currentPath.join("/")}] target=[${
              targetSegments.join("/")
            }] action=${plan.action}`,
          );
          if (plan.action === "none") {
            await waitForFileListReady(homePage);
          } else if (plan.action === "navigate") {
            for (const segment of plan.segments) {
              yield { type: "status", message: `double click ${segment}` };
              await openPathSegment(homePage, segment);
              await waitForFileListReady(homePage);
            }
          } else {
            yield { type: "status", message: "click 首页" };
            await resetToHome(homePage);
            for (const segment of plan.segments) {
              yield { type: "status", message: `double click ${segment}` };
              await openPathSegment(homePage, segment);
              await waitForFileListReady(homePage);
            }
          }
        } else {
          log.debug(
            "listFile: nav=[home] breadcrumb unreadable, full reset",
          );
          yield { type: "status", message: "click 首页" };
          await resetToHome(homePage);
          for (const segment of targetSegments) {
            yield { type: "status", message: `double click ${segment}` };
            await openPathSegment(homePage, segment);
            await waitForFileListReady(homePage);
          }
        }
      } else {
        log.debug(`listFile: nav=[other], switching to home nav`);
        yield { type: "status", message: "click 首页" };
        await resetToHome(homePage);
        for (const segment of targetSegments) {
          yield { type: "status", message: `double click ${segment}` };
          await openPathSegment(homePage, segment);
          await waitForFileListReady(homePage);
        }
      }

      await waitForFileListReady(homePage);
      yield { type: "status", message: "读取首页滚动列表" };

      // Collect with streaming progress: scrollAndCollect reports deduped
      // item counts through a channel that this generator relays as
      // `collecting` events.
      let items: QuarkFileListItem[] = [];
      const scrollContainer = getScrollContainer(homePage);
      if (await scrollContainer.isVisible().catch(() => false)) {
        const progress = new Channel<number>();
        const collectPromise = (async () => {
          try {
            return await scrollAndCollect<QuarkFileListItem>({
              page: homePage,
              scrollContainer,
              readVisible: () => readVisibleRows(homePage),
              getKey: listFileItemKey,
              label: "fileList",
              onProgress: (seen) => progress.push(seen),
            });
          } finally {
            progress.close();
          }
        })();

        try {
          while (true) {
            const seen = await progress.recv();
            if (seen === null) break;
            yield { type: "collecting", seen, total: 0 };
          }
          items = await collectPromise;
        } finally {
          progress.close();
        }
      } else {
        log.trace("listFile: empty folder, skipping virtual-list collection");
      }

      const pathSegments = await readBreadcrumbPath(homePage);
      log.debug(
        `listFile: ${items.length} items at path=[${pathSegments.join("/")}]`,
      );
      const result: QuarkFileList = { path: pathSegments, items };
      return result;
    },
  );
}

async function describeCurrentPage(homePage: Page): Promise<string> {
  const route = getPageRoute(homePage);
  if (!route.startsWith(FILE_LIST_ROUTE)) {
    if (route.startsWith("/transport")) return "传输";
    return route || "未知";
  }

  const path = await readBreadcrumbPath(homePage).catch(() => null);
  return path === null || path.length === 0 ? "首页" : `首页/${path.join("/")}`;
}
