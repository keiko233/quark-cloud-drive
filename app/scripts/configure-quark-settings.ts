/**
 * Keep settings that are required by the containerized Quark instance
 * deterministic across fresh and existing wine-data volumes.
 *
 * This intentionally changes only the settings owned by the deployment:
 * downloads are enabled at the mounted Downloads directory and the desktop
 * floating window is disabled. Unknown settings are preserved.
 */

import { readFile, writeFile } from "node:fs/promises";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: configure-quark-settings.ts <quark-data-dir>");
  process.exit(2);
}

const preferencePath = `${dataDir}/preference.json`;
const downloadPath = "C:\\users\\wineuser\\Downloads";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

let preference: Record<string, unknown>;
try {
  preference = JSON.parse(await readFile(preferencePath, "utf8"));
  if (!isRecord(preference)) throw new Error("root value is not an object");
} catch (error) {
  if (!isNotFound(error)) {
    throw new Error(`cannot read or parse ${preferencePath}: ${error}`);
  }
  preference = {};
}

const globalSetting = isRecord(preference["global:setting"])
  ? preference["global:setting"]
  : {};
const downloadPosition = isRecord(globalSetting.downloadPosition)
  ? globalSetting.downloadPosition
  : {};
const permissionSwitch = isRecord(globalSetting.permissionSwitch)
  ? globalSetting.permissionSwitch
  : {};

const changed = downloadPosition.where !== downloadPath ||
  downloadPosition.enable !== true ||
  permissionSwitch.floatingWinEnable !== false;

if (!changed) {
  console.log(`Quark settings already normalized: ${preferencePath}`);
  process.exit(0);
}

downloadPosition.where = downloadPath;
downloadPosition.enable = true;
permissionSwitch.floatingWinEnable = false;
globalSetting.downloadPosition = downloadPosition;
globalSetting.permissionSwitch = permissionSwitch;
preference["global:setting"] = globalSetting;

await writeFile(
  preferencePath,
  `${JSON.stringify(preference, null, "\t")}\n`,
);
console.log(`Normalized Quark settings: ${preferencePath}`);
