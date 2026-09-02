import type { Locator, Page } from "playwright";
import type {
  DownloadFileStreamEvent,
  QuarkDownloadFileResult,
} from "@quark/contract/schemas";
import { log } from "../logger.ts";
import { getOperationQueue } from "../browser/context.ts";
import { getHomePage, scrollListToRow } from "../browser/page-utils.ts";
import { downloadStatusCache } from "../cache/caches.ts";
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
import { readDownloadTaskNamesRaw } from "./download-status.ts";

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

const ROW_CHECKBOX_SELECTOR = "td:first-child label.ant-checkbox-wrapper";
const ROW_CHECKBOX_INPUT_SELECTOR =
  `${ROW_CHECKBOX_SELECTOR} input[type="checkbox"]`;
const BATCH_DOWNLOAD_BUTTON_SELECTOR = "#quark-cloud-drive-section-main > " +
  "div.quark-cloud-drive-file-list-header > " +
  "div.list-header-bottom > " +
  "div.list-header-right > " +
  "div.button-flow-group-container > div > button:nth-child(1)";
const DOWNLOAD_BUTTON_TIMEOUT = 10_000;

async function waitForCheckboxState(
  input: Locator,
  checked: boolean,
): Promise<void> {
  const deadline = Date.now() + DOWNLOAD_BUTTON_TIMEOUT;
  while (Date.now() < deadline) {
    if ((await input.isChecked()) === checked) return;
    await input.page().waitForTimeout(100);
  }
  throw new Error(
    `Quark row checkbox did not become ${checked ? "checked" : "unchecked"}`,
  );
}

/**
 * Quark's stable download flow is row selection followed by the batch toolbar
 * action. Do not use the row hover actions: their order changes by file type
 * (archives expose 解压 before 下载).
 */
async function clickDownloadButton(
  homePage: Page,
  row: Locator,
): Promise<void> {
  await row.scrollIntoViewIfNeeded();
  await row.waitFor({ state: "visible", timeout: 5_000 });

  const targetKey = await row.getAttribute("data-row-key");
  const selectedRows = homePage.locator(
    `${TABLE_ROW_SELECTOR}.ant-table-row-selected`,
  );
  for (let index = 0; index < await selectedRows.count(); index++) {
    const selected = selectedRows.nth(index);
    if (await selected.getAttribute("data-row-key") === targetKey) continue;
    const selectedInput = selected.locator(ROW_CHECKBOX_INPUT_SELECTOR).first();
    await selectedInput.click();
    await waitForCheckboxState(selectedInput, false);
  }

  const input = row.locator(ROW_CHECKBOX_INPUT_SELECTOR).first();
  await input.waitFor({ state: "attached", timeout: 5_000 });
  if (!await input.isChecked()) {
    await input.click();
  }
  await waitForCheckboxState(input, true);

  const download = homePage.locator(BATCH_DOWNLOAD_BUTTON_SELECTOR).filter({
    hasText: /^\s*下载\s*$/,
  }).first();

  const deadline = Date.now() + DOWNLOAD_BUTTON_TIMEOUT;
  let ready = false;
  while (Date.now() < deadline) {
    if (
      await download.isVisible().catch(() => false) &&
      await download.isEnabled().catch(() => false)
    ) {
      ready = true;
      break;
    }
    await homePage.waitForTimeout(200);
  }
  if (!ready) {
    throw new Error(
      "Quark's 下载 button did not become enabled after row selection",
    );
  }
  await download.click();
  await homePage.waitForTimeout(500);
}

/**
 * Queued streaming entry point. Yields `navigating`/`clicking` progress, then
 * returns `{name, alreadyQueued?}`.
 */
export function downloadFile(
  path: string,
): Promise<AsyncGenerator<DownloadFileStreamEvent, QuarkDownloadFileResult>> {
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

      // Dedup against Quark's native task index. Reading the rendered
      // transport panel would navigate away from the file list before the
      // actual download click and clear the current row selection.
      const normalizedName = normalizeFileListText(target.fileName);
      const taskNames = await readDownloadTaskNamesRaw();
      if (
        taskNames?.some((name) =>
          normalizeFileListText(name) === normalizedName
        )
      ) {
        log.debug(
          `downloadFile: "${target.fileName}" already in transport list, skipping click`,
        );
        return { name: target.fileName, alreadyQueued: true };
      }

      yield { type: "clicking", name: target.fileName };
      const row = await findFileRow(homePage, normalizedName);
      await clickDownloadButton(homePage, row);

      log.debug(`downloadFile: queued "${target.fileName}"`);
      const result: QuarkDownloadFileResult = { name: target.fileName };
      downloadStatusCache.clear();
      return result;
    },
  );
}
