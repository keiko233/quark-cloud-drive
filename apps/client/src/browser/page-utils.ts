/// <reference lib="dom" />
import type { BrowserContext, Locator, Page } from "playwright";
import { getBrowser } from "./context.ts";
import { findPageByUrl } from "../utils.ts";
import { QUARK_HOME_PAGE_URL } from "../consts.ts";
import { log } from "../logger.ts";

/** Returns the hash path of the page's URL, without search params (e.g. "/list/all"). */
export function getPageRoute(page: Page): string {
  const hash = page.url().split("#")[1] ?? "";
  return hash.split("?")[0];
}

export function getBrowserContext(): BrowserContext {
  const context = getBrowser().contexts()[0];
  if (!context) throw new Error("No BrowserContext found");
  return context;
}

export function getHomePage(): Page {
  const context = getBrowserContext();
  const page = findPageByUrl(context, QUARK_HOME_PAGE_URL);
  if (!page) throw new Error(`Home page not found: ${QUARK_HOME_PAGE_URL}`);
  log.trace(`getHomePage: found page url=${page.url()}`);
  return page;
}

export interface ScrollCollectOptions<T> {
  page: Page;
  scrollContainer: Locator;
  readVisible: () => Promise<T[]>;
  getKey: (item: T) => string;
  readSnapshot?: () => Promise<string>;
  stableThreshold?: number;
  settleTimeoutMs?: number;
  label?: string;
  /** Called after each viewport read with the current deduped item count. */
  onProgress?: (seen: number) => void;
}

export interface WaitForSnapshotStableOptions {
  pollMs?: number;
  stableRounds?: number;
  timeoutMs?: number;
}

export async function waitForSnapshotStable(
  page: Page,
  readSnapshot: () => Promise<string>,
  options?: WaitForSnapshotStableOptions,
): Promise<void> {
  const pollMs = options?.pollMs ?? 120;
  const stableRounds = options?.stableRounds ?? 2;
  const timeoutMs = options?.timeoutMs ?? 3_000;

  const startedAt = Date.now();
  let prev = await readSnapshot();
  let stable = 0;

  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(pollMs);
    const next = await readSnapshot();
    if (next === prev) {
      stable++;
      if (stable >= stableRounds) return;
    } else {
      stable = 0;
      prev = next;
    }
  }

  log.warn(
    `waitForSnapshotStable: timed out after ${timeoutMs}ms ` +
      `(reached ${stable}/${stableRounds} stable rounds)`,
  );
}

export async function scrollOneViewportAndSettle(
  page: Page,
  scrollContainer: Locator,
  readSnapshot: () => Promise<string>,
  options?: { settleTimeoutMs?: number },
): Promise<{ before: number; after: number; atBottom: boolean }> {
  const settleTimeoutMs = options?.settleTimeoutMs ?? 3_000;
  const result = await scrollContainer.evaluate((el) => {
    const before = el.scrollTop;
    el.scrollTop = Math.min(
      el.scrollTop + el.clientHeight,
      el.scrollHeight,
    );
    return {
      before,
      after: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    };
  });

  const atBottom = result.before === result.after ||
    result.after + result.clientHeight >= result.scrollHeight - 2;

  await waitForSnapshotStable(page, readSnapshot, {
    timeoutMs: settleTimeoutMs,
  });
  return { before: result.before, after: result.after, atBottom };
}

export type RowNameParser = string | ((root: Element) => string);

export interface ScrollListToRowOptions {
  page: Page;
  scrollContainer: Locator;
  rowSelector: string;
  nameInRow: RowNameParser;
  targetName: string;
  maxHops?: number;
  settleTimeoutMs?: number;
  settlePollMs?: number;
}

export async function scrollListToRow(
  opts: ScrollListToRowOptions,
): Promise<Locator> {
  const {
    page,
    scrollContainer,
    rowSelector,
    nameInRow,
    targetName,
    maxHops = 50,
    settleTimeoutMs = 3_000,
    settlePollMs = 120,
  } = opts;

  const snapshot = () => readNamesSnapshot(page, rowSelector, nameInRow);

  const candidates = () =>
    page.locator(rowSelector).filter({ hasText: targetName });

  log.debug(
    `scrollListToRow: looking for "${targetName}" in "${rowSelector}"`,
  );

  await scrollContainer.evaluate((el) => {
    el.scrollTop = 0;
  });
  await waitForSnapshotStable(page, snapshot, {
    pollMs: settlePollMs,
    timeoutMs: settleTimeoutMs,
  });

  for (let hop = 0; hop < maxHops; hop++) {
    const count = await candidates().count();
    if (count > 0) {
      log.debug(
        `scrollListToRow: found "${targetName}" after ${hop} hops ` +
          `(${count} candidate(s))`,
      );
      return candidates().first();
    }
    const scrollResult = await scrollOneViewportAndSettle(
      page,
      scrollContainer,
      snapshot,
      { settleTimeoutMs },
    );
    if (scrollResult.after === scrollResult.before) {
      throw new Error(
        `scrollListToRow: target "${targetName}" not found at bottom of list`,
      );
    }
  }

  throw new Error(
    `scrollListToRow: target "${targetName}" not found after ${maxHops} hops`,
  );
}

export async function readNamesSnapshot(
  page: Page,
  rowSelector: string,
  nameInRow: RowNameParser,
): Promise<string> {
  return await page.evaluate(
    ([rows, sel, isFn, fnSrc]: [string, string, boolean, string | null]) => {
      const get = (root: Element): string => {
        if (isFn && fnSrc) {
          // eslint-disable-next-line no-new-func
          const f = new Function("el", `return (${fnSrc})(el);`);
          return String(f(root) ?? "");
        }
        const el = root.querySelector(sel);
        if (!el) return "";
        const cloned = el.cloneNode(true) as Element;
        cloned
          .querySelectorAll(".all-file-list-mode-tips")
          .forEach((t) => t.remove());
        return (cloned.textContent ?? "").replace(/\s+/g, " ").trim();
      };
      return Array.from(document.querySelectorAll(rows))
        .map((r) => get(r))
        .filter(Boolean)
        .join("");
    },
    [
      rowSelector,
      typeof nameInRow === "function" ? "" : (nameInRow as string),
      typeof nameInRow === "function",
      typeof nameInRow === "function" ? nameInRow.toString() : null,
    ] as [string, string, boolean, string | null],
  );
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function scrollAndCollect<T>(
  opts: ScrollCollectOptions<T>,
): Promise<T[]> {
  const {
    page,
    scrollContainer,
    readVisible,
    getKey,
    readSnapshot,
    stableThreshold = 2,
    settleTimeoutMs = 3_000,
    label = "scrollAndCollect",
    onProgress,
  } = opts;

  log.debug(`scrollAndCollect [${label}]: start`);

  await scrollContainer.evaluate((el) => {
    el.scrollTop = 0;
  });

  const snapshot = readSnapshot ??
    (async () => (await readVisible()).map(getKey).join("\n"));

  await waitForSnapshotStable(page, snapshot, { timeoutMs: settleTimeoutMs });

  const seen = new Map<string, T>();
  let atBottomStreak = 0;

  while (atBottomStreak < stableThreshold) {
    const visible = await readVisible();
    for (const item of visible) seen.set(getKey(item), item);
    onProgress?.(seen.size);

    const scrollResult = await scrollOneViewportAndSettle(
      page,
      scrollContainer,
      snapshot,
      { settleTimeoutMs },
    );

    log.trace(
      `scrollAndCollect [${label}]: seen=${seen.size} scrollTop=${scrollResult.after} atBottomStreak=${atBottomStreak} atBottom=${scrollResult.atBottom}`,
    );

    if (scrollResult.after === scrollResult.before) {
      atBottomStreak++;
    } else {
      atBottomStreak = scrollResult.atBottom ? atBottomStreak + 1 : 0;
    }
  }

  log.debug(
    `scrollAndCollect [${label}]: done, collected ${seen.size} items`,
  );
  return [...seen.values()];
}

export { normalize };
