/// <reference lib="dom" />
import type { BrowserContext, Locator, Page } from "playwright";
import { getBrowser } from "./browser.ts";
import { findPageByUrl } from "../libs/utils.ts";
import { QUARK_HOME_PAGE_URL } from "../consts.ts";
import { log } from "../libs/logger.ts";

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
  /**
   * Fingerprint of the currently-rendered viewport state. Used to detect
   * when the virtual list has finished rendering the new viewport after a
   * scroll. Defaults to the keys of the currently-visible items, which is
   * the right answer for the file list and the download-task list. Override
   * for callers that have a cheaper or more discriminating signal.
   */
  readSnapshot?: () => Promise<string>;
  stableThreshold?: number;
  settleTimeoutMs?: number;
  label?: string;
}

export interface WaitForSnapshotStableOptions {
  /** How long to wait between snapshot polls. Default 120ms. */
  pollMs?: number;
  /** How many consecutive equal polls confirm "settled". Default 2. */
  stableRounds?: number;
  /** Hard ceiling. Default 3000ms. */
  timeoutMs?: number;
}

/**
 * Wait until `readSnapshot` returns the same string for `stableRounds`
 * consecutive polls (or the timeout elapses). Used after scrolling a
 * virtual list — the DOM swap is asynchronous, so a fast scroll + immediate
 * read will miss rows that haven't rendered yet. Polling for stability
 * guarantees we only proceed once the viewport has actually settled into
 * its new state.
 *
 * The function is intentionally cheap to call when the viewport is already
 * stable: the first poll matches itself, and the second poll matches the
 * first, so we exit after `pollMs * stableRounds` of waiting.
 */
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

/**
 * Scroll the container to the next viewport, then block until the virtual
 * list has finished rendering. Returns the scroll result so the caller can
 * tell whether it actually moved (and detect the bottom).
 */
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

  await waitForSnapshotStable(page, readSnapshot, { timeoutMs: settleTimeoutMs });
  return { before: result.before, after: result.after, atBottom };
}

/**
 * The selector inside each row that holds the row's display name. Used by
 * `scrollListToRow` to take a snapshot of the viewport and to pick out the
 * target row by name. The parser strips `all-file-list-mode-tips` badges
 * (file list) — for other lists, pass a parser that just reads textContent.
 */
export type RowNameParser = string | ((root: Element) => string);

export interface ScrollListToRowOptions {
  page: Page;
  scrollContainer: Locator;
  /**
   * CSS selector for one row in the virtual list, e.g.
   * `tbody.ant-table-tbody > tr` (file list) or `div.task-item`
   * (transport center). Rows are filtered by `targetName` to find the
   * match.
   */
  rowSelector: string;
  /**
   * Either a CSS selector for the element inside the row that holds the
   * display name (e.g. `td.td-file.file-name .filename-text`), OR a
   * function `(row) => string` that returns the normalized name.
   */
  nameInRow: RowNameParser;
  /** Exact name of the target row. */
  targetName: string;
  /** Max viewport-scroll hops before giving up. Default 50. */
  maxHops?: number;
  /** Per-settle ceiling. Default 3000ms. */
  settleTimeoutMs?: number;
  /** Per-snapshot-poll cadence. Default 120ms. */
  settlePollMs?: number;
}

/**
 * Scroll a virtual list until a row whose display name matches
 * `targetName` is rendered and in the visible viewport. Returns the row's
 * `Locator` so callers can `hover()` / `click()` / `dblclick()` on it
 * without ever going through a DOM index — the row at DOM index N in an
 * Ant Design virtual table is not the same as the row at visual position
 * N, and that's the off-screen-click bug this helper exists to fix.
 *
 * The returned Locator is the *element* Playwright will scroll into view
 * and interact with; pass it to `.scrollIntoViewIfNeeded()` /
 * `.hover()` / `.click()` (which auto-waits for visibility) on the
 * call site.
 */
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

  // A fingerprint of the current viewport — the joined display names of
  // every rendered row, in DOM order. Used to detect when the virtual
  // list has finished swapping rows in response to a scroll.
  const snapshot = () => readNamesSnapshot(page, rowSelector, nameInRow);

  // The list of candidate row locators. We re-resolve on every check
  // because virtual-table DOM recycling can swap elements underneath us;
  // the filter expression stays stable so Playwright re-runs it each
  // time. `.first()` is the right pick because we always scroll to the
  // first viewport match — any other match is a duplicate-name row.
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
      // The first rendered match. Returning a fresh Locator so the
      // caller's `await row.click()` re-resolves it against whatever the
      // DOM looks like at click-time — by then the row should be in view
      // after the caller's `scrollIntoViewIfNeeded`.
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

/**
 * Read the display name of every currently-rendered row in a virtual list
 * and join them. Used as the snapshot input to `waitForSnapshotStable`.
 * Exported for callers that want a snapshot without going through the
 * full scroll+find machinery.
 */
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
  } = opts;

  log.debug(`scrollAndCollect [${label}]: start`);

  await scrollContainer.evaluate((el) => {
    el.scrollTop = 0;
  });

  // Fingerprint the viewport. Defaults to the keys of the currently-visible
  // items, which is what changes when a virtual list swaps in new rows.
  const snapshot = readSnapshot ??
    (async () => (await readVisible()).map(getKey).join("\n"));

  // Wait for the initial viewport to settle before reading it. Cheap when
  // already stable (one poll interval, then the helper returns).
  await waitForSnapshotStable(page, snapshot, { timeoutMs: settleTimeoutMs });

  const seen = new Map<string, T>();
  let lastScrollTop = -1;
  let atBottomStreak = 0;

  while (atBottomStreak < stableThreshold) {
    const visible = await readVisible();
    for (const item of visible) seen.set(getKey(item), item);

    // Scroll the next viewport, then BLOCK until the virtual list has
    // finished rendering it. A fixed waitMs is not enough — the bug it
    // caused was scrolling past rows whose DOM swap was still in flight,
    // which meant the next `readVisible` never saw them and `seen` lost
    // entries permanently.
    const scrollResult = await scrollOneViewportAndSettle(
      page,
      scrollContainer,
      snapshot,
      { settleTimeoutMs },
    );

    log.trace(
      `scrollAndCollect [${label}]: seen=${seen.size} scrollTop=${
        scrollResult.after
      } atBottomStreak=${atBottomStreak} atBottom=${scrollResult.atBottom}`,
    );

    // The list is exhausted when the container refuses to scroll AND
    // we've seen the bottom in `scrollResult.atBottom` for `stableThreshold`
    // consecutive rounds. A stuck-at-bottom virtual list is the normal
    // exit condition; an unexpected non-scroll (e.g. container got
    // hidden) would also count.
    if (scrollResult.after === scrollResult.before) {
      atBottomStreak++;
    } else {
      atBottomStreak = scrollResult.atBottom ? atBottomStreak + 1 : 0;
      lastScrollTop = scrollResult.after;
    }
  }

  log.debug(
    `scrollAndCollect [${label}]: done, collected ${seen.size} items`,
  );
  return [...seen.values()];
}
