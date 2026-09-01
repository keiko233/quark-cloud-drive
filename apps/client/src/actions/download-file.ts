import type { Locator, Page } from "playwright";
import type {
  DownloadFileStreamEvent,
  QuarkDownloadFileResult,
} from "@quark/contract/schemas";
import { log } from "../logger.ts";
import { getOperationQueue } from "../browser/context.ts";
import { getHomePage, scrollListToRow } from "../browser/page-utils.ts";
import { downloadFileCache, downloadStatusCache } from "../cache/caches.ts";
import {
  extractFileListRowName,
  getScrollContainer,
  isAtPath,
  navigateToPath,
  normalizeFileListText,
  parsePathSegments,
  resetToHome,
  TABLE_ROW_SELECTOR,
  waitForFileListReady,
} from "./list-file.ts";
import { readDownloadStatusRaw } from "./download-status.ts";

function getTargetFromPath(
  path: string,
): { parentPath: string; fileName: string } {
  const segments = parsePathSegments(path);
  const fileName = segments.at(-1);

  if (!fileName) throw new Error("Download file path is empty");

  return {
    parentPath: segments.slice(0, -1).join("/"),
    fileName,
  };
}

async function findFileRow(
  homePage: Page,
  fileName: string,
): Promise<Locator> {
  return await scrollListToRow({
    page: homePage,
    scrollContainer: getScrollContainer(homePage),
    rowSelector: TABLE_ROW_SELECTOR,
    nameInRow: extractFileListRowName,
    targetName: fileName,
  });
}

async function clickDownloadButton(row: Locator): Promise<void> {
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const button = row
    .locator(".hover-oper > .hover-oper-list > .hover-oper-item")
    .first();
  await button.waitFor({ state: "visible", timeout: 5_000 });
  await button.click();
}

/**
 * Queued streaming entry point. Yields `navigating`/`clicking` progress, then
 * returns `{name, alreadyQueued?}`.
 */
export function downloadFile(
  path: string,
): Promise<AsyncGenerator<DownloadFileStreamEvent, QuarkDownloadFileResult>> {
  const cached = downloadFileCache.get(path);
  if (cached !== undefined) {
    // deno-lint-ignore require-yield
    return Promise.resolve((async function* () {
      return cached;
    })());
  }

  return getOperationQueue().runStreaming(
    "downloadFile",
    { key: `downloadFile:${path}` },
    async function* () {
      log.debug(`downloadFile: path="${path}"`);

      const target = getTargetFromPath(path);
      const targetSegments = parsePathSegments(target.parentPath);
      const homePage = getHomePage();
      await homePage.bringToFront();
      await homePage.waitForLoadState("domcontentloaded");

      if (target.parentPath) {
        const alreadyAt = await isAtPath(homePage, targetSegments);
        if (alreadyAt) {
          log.trace(
            "downloadFile: already at target path, skipping navigation",
          );
        } else {
          yield { type: "navigating", path: target.parentPath };
          await resetToHome(homePage);
          await navigateToPath(homePage, target.parentPath);
        }
      } else {
        yield { type: "navigating", path: "" };
        await resetToHome(homePage);
      }
      await waitForFileListReady(homePage);

      // Dedup against the live transport panel (raw read — never re-enter the
      // queue from inside this operation).
      const normalizedName = normalizeFileListText(target.fileName);
      const status = await readDownloadStatusRaw("all");
      if (status.tasks.some((t) => t.name === normalizedName)) {
        log.debug(
          `downloadFile: "${target.fileName}" already in transport list, skipping click`,
        );
        return { name: target.fileName, alreadyQueued: true };
      }

      yield { type: "clicking", name: target.fileName };
      const row = await findFileRow(homePage, normalizedName);
      await clickDownloadButton(row);

      log.debug(`downloadFile: queued "${target.fileName}"`);
      const result: QuarkDownloadFileResult = { name: target.fileName };
      downloadFileCache.set(path, result);
      downloadStatusCache.clear();
      return result;
    },
  );
}
