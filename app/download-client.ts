import { chromium } from "playwright";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const QUARK_PAN_CLIENT_OFFICIAL_SITE_URL = "https://pan.quark.cn/";
const INSTALLER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../private/installer.exe",
);

async function hasExistingInstaller(installerPath: string) {
  try {
    return (await stat(installerPath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function main() {
  const installerPath = INSTALLER_PATH;
  const existingInstallerAvailable = await hasExistingInstaller(installerPath);

  const browser = await chromium.launch({
    headless: true,
  });
  const context = await browser.newContext({
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    try {
      await page.goto(QUARK_PAN_CLIENT_OFFICIAL_SITE_URL, {
        waitUntil: "domcontentloaded",
      });

      const downloadButton = page.locator(
        'div.download-btn:has-text("下载客户端")',
      ).first();
      const windowsDownloadCard = page.locator(".download-item.win.is-click")
        .first();

      await downloadButton.waitFor({ state: "visible" });
      await downloadButton.click();
      await windowsDownloadCard.waitFor({ state: "visible" });

      const installerRequestPromise = page.waitForRequest((request) => {
        return /https:\/\/umcdn\.quark\.cn\/download\/.*\.exe/i.test(
          request.url(),
        );
      });

      await windowsDownloadCard.click();
      const installerRequest = await installerRequestPromise;
      const installerResponse = await fetch(installerRequest.url());

      if (!installerResponse.ok || !installerResponse.body) {
        throw new Error(
          `Download failed: ${installerResponse.status} ${installerResponse.statusText}`,
        );
      }

      await Bun.write(installerPath, installerResponse);

      console.log(`Installer saved to ${installerPath}`);
    } catch (error) {
      if (!existingInstallerAvailable) {
        throw error;
      }

      console.warn(
        `Falling back to the committed installer at ${installerPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

if (import.meta.main) {
  await main();
}
