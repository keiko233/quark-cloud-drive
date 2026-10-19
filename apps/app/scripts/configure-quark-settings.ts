/**
 * Keep settings that are required by the containerized Quark instance
 * deterministic across fresh and existing wine-data volumes.
 *
 * This intentionally changes only the settings owned by the deployment:
 * downloads are enabled at the mounted Downloads directory and the desktop
 * floating window is disabled. Unknown settings are preserved.
 */

const dataDir = Deno.args[0];
if (!dataDir) {
  console.error("usage: configure-quark-settings.ts <quark-data-dir>");
  Deno.exit(2);
}

const preferencePath = `${dataDir}/preference.json`;
const downloadPath = "C:\\users\\wineuser\\Downloads";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let preference: Record<string, unknown>;
try {
  preference = JSON.parse(await Deno.readTextFile(preferencePath));
  if (!isRecord(preference)) throw new Error("root value is not an object");
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) {
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
  Deno.exit(0);
}

downloadPosition.where = downloadPath;
downloadPosition.enable = true;
permissionSwitch.floatingWinEnable = false;
globalSetting.downloadPosition = downloadPosition;
globalSetting.permissionSwitch = permissionSwitch;
preference["global:setting"] = globalSetting;

await Deno.writeTextFile(
  preferencePath,
  `${JSON.stringify(preference, null, "\t")}\n`,
);
console.log(`Normalized Quark settings: ${preferencePath}`);
