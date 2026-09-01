import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { QuarkDownloadFileResult } from "../../libs/schemas.ts";
import { log } from "../../libs/logger.ts";
import { getHomePage, scrollListToRow } from "../page-utils.ts";
import { TtlCache } from "../cache.ts";
import { createAction, unwrapResult } from "./create-action.ts";
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
} from "./get-file-list.ts";
import { getDownloadStatus } from "./get-download-status.ts";

export type { QuarkDownloadFileResult };

/**
 * Short TTL dedup — a 5 s window after a successful click suppresses
 * near-simultaneous triggers of the same path. The cache is set on success
 * only (via `createAction`'s cache write), so a failed click can be
 * retried immediately.
 */
const downloadFileCache = new TtlCache<string, QuarkDownloadFileResult>(5_000);

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
  // Bring the row into the viewport first. `scrollListToRow` may have
  // returned a row that was in DOM but rendered below the fold (the
  // Ant Design virtual table's pre-render buffer). Without this, the
  // hover state never engages and the click falls through.
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  // Re-resolve the button AFTER the hover so Playwright doesn't
  // snapshot a hidden handle. Auto-wait covers "row is visible" and
  // "button is visible" — the hover is what makes the second true.
  const button = row
    .locator(".hover-oper > .hover-oper-list > .hover-oper-item")
    .first();
  await button.waitFor({ state: "visible", timeout: 5_000 });
  await button.click();
}

/**
 * Drive a Quark download:
 *   1. Navigate to the parent folder (skipping if already there).
 *   2. Wait for the file list to be ready.
 *   3. If the file is already in Quark's transport center (running or
 *      complete), skip the click — it's been queued.
 *   4. Scroll the target row into view, hover it (so the row's hover
 *      overlay paints), and click the first hover-oper item (the
 *      download button).
 *
 * The whole flow runs behind `createAction`'s single-slot browser queue
 * (concurrency: 1) so two simultaneous calls don't race for focus.
 */
export async function downloadFileImpl(
  path: string,
): Promise<QuarkDownloadFileResult> {
  log.debug(`downloadFile: path="${path}"`);

  const target = getTargetFromPath(path);
  const targetSegments = parsePathSegments(target.parentPath);
  const homePage = getHomePage();
  await homePage.bringToFront();
  await homePage.waitForLoadState("domcontentloaded");

  if (target.parentPath) {
    const alreadyAt = await isAtPath(homePage, targetSegments);
    if (alreadyAt) {
      log.trace("downloadFile: already at target path, skipping navigation");
    } else {
      await resetToHome(homePage);
      await navigateToPath(homePage, target.parentPath);
    }
  } else {
    await resetToHome(homePage);
  }
  await waitForFileListReady(homePage);

  // Dedup against the live transport panel. If the file is already
  // running or complete in Quark's queue, return early without clicking.
  const normalizedName = normalizeFileListText(target.fileName);
  const statusResult = await getDownloadStatus("all");
  const status = unwrapResult<{ tasks: { name: string }[] }>(statusResult);
  if (status.tasks.some((t) => t.name === normalizedName)) {
    log.debug(
      `downloadFile: "${target.fileName}" already in transport list, skipping click`,
    );
    return { name: target.fileName, alreadyQueued: true };
  }

  const row = await findFileRow(homePage, normalizedName);
  await clickDownloadButton(row);

  log.debug(`downloadFile: queued "${target.fileName}"`);
  return { name: target.fileName };
}

export const downloadFile = createAction(
  "downloadFile",
  downloadFileImpl,
  {
    description: [
      "Trigger a download in the Quark client.",
      "",
      "Works for BOTH files and folders. Quark itself handles the folder",
      "case by packaging the directory client-side; you'll see a single",
      "task in the transport center either way.",
      "",
      "Returns `{name, alreadyQueued?}` where `alreadyQueued: true` means",
      "the item was already in the transport center (running or complete)",
      "and we skipped the click.",
      "",
      "Dedup: a 5 s same-path cache suppresses redundant duplicate-path",
      "triggers. The call itself blocks until the download button has been",
      "clicked — actual bytes flow inside Quark's own download queue, which",
      "you can watch with `get_download_status`.",
    ].join("\n"),
    mcp: {
      name: "download_file",
      input: z.object({
        path: z.string().describe(
          "Full path to the file OR folder in Quark drive, forward-slash " +
            "separated (e.g. `Movies/2024/movie.mp4` for a file, or " +
            "`Movies/2024` for a folder). Folder downloads are packaged " +
            "into a single transport-center task by Quark itself.",
        ),
      }),
    },
    cache: {
      cache: downloadFileCache,
      key: (path: string) => path,
      keyLabel: (key) => ` path="${key}"`,
    },
  },
);
