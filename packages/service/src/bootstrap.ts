// @quark/service — the composition root.
//
// One process owns the whole app: the process manager (embedded, or remote
// over HTTP), the CDP proxy, the manager API, the public API surface, the idle
// monitor, and the renderer attach loop. The entrypoint in app only calls
// this and nothing else.

import { existsSync } from "node:fs";
import {
  createEmbeddedManager,
  createHttpManager,
  ProcessManager,
  setManager,
  startCdpProxy,
} from "@quark/manager";
import {
  LAUNCH_SCRIPT,
  log,
  MANAGER_MODE,
  MANAGER_URL,
  QUARK_AUTOSTART,
  RECONNECT_INTERVAL_MS,
  WINE_BIN,
} from "@quark/config";
import { getManager } from "@quark/manager";
import { attachStoreHooks, kvStore } from "@quark/drive";
import { autoWakeBlockReason } from "./monitor/wake.ts";
import { startService } from "./rpc/index.ts";
import { sleeper } from "./rpc/runtime.ts";
import { connect } from "./session/connect.ts";

export interface BootstrapOptions {
  /** Skip the background renderer attach loop (API-only runs, tests). */
  attachRenderer?: boolean;
}

/**
 * Start everything and return once every listener is up. The renderer attach
 * loop keeps retrying in the background; a missing Wine/Quark host is not
 * fatal, because the API surface and the manager stay usable.
 */
export async function bootstrap(
  options: BootstrapOptions = {},
): Promise<void> {
  await kvStore.open();
  attachStoreHooks();

  const embedded = MANAGER_MODE !== "http";
  const wineAvailable = !embedded || existsSync(WINE_BIN);

  if (!embedded) {
    setManager(createHttpManager(MANAGER_URL));
    log.info(`manager: http (${MANAGER_URL})`);
  } else {
    if (MANAGER_MODE !== "embedded") {
      log.warn(`unknown QUARK_MANAGER_MODE "${MANAGER_MODE}" — using embedded`);
    }
    const processManager = new ProcessManager();
    startCdpProxy({ onActivity: () => processManager.markActivity() });
    setManager(createEmbeddedManager(processManager));
    log.info("manager: embedded (mounted at /manager)");
    if (wineAvailable) {
      autostart(processManager);
    } else {
      log.warn(
        `Wine runtime not found at "${WINE_BIN}" — starting API only. ` +
          "Run inside the Docker dev overlay to manage Quark.",
      );
    }
  }

  startService();
  sleeper.start();

  if (options.attachRenderer !== false && wineAvailable) {
    void attachLoop();
  } else if (options.attachRenderer !== false) {
    log.warn("renderer attach disabled because Wine is unavailable");
  }
}

/** Cold-start Quark when the launch script exists; never fatal. */
function autostart(processManager: ProcessManager): void {
  if (!QUARK_AUTOSTART) return;
  if (!processManager.launchScriptAvailable()) {
    // Local dev hosts usually lack the Wine/Quark launch script — don't spam
    // an ERROR, just skip autostart and keep the API + CDP proxy up.
    log.warn(
      `QUARK_AUTOSTART=true but launch script missing at "${LAUNCH_SCRIPT}" — ` +
        "skipping autostart. Install it, set LAUNCH_SCRIPT, or set " +
        "QUARK_AUTOSTART=false.",
    );
    return;
  }
  processManager.start().catch((e) => log.error("autostart failed:", e));
}

/**
 * Keep one CDP attachment alive. `connect()` resolves when the renderer goes
 * away, so this loop is also the reconnect policy.
 */
async function attachLoop(): Promise<void> {
  let recoveryAttempts = 0;
  // undefined means no attempt has been inspected yet. An adopted Wine
  // process has startedAt=null, but its first failed renderer still needs
  // recovery after a Bun server reload.
  let failedLaunchAt: number | null | undefined;
  let pendingVerification = false;
  while (true) {
    pendingVerification = false;
    try {
      await connect();
      recoveryAttempts = 0;
      failedLaunchAt = undefined;
    } catch (err) {
      log.error("ERROR:", err);
      try {
        if (await autoWakeBlockReason() === null) {
          const status = await getManager().status();
          if (status.startedAt !== failedLaunchAt) {
            failedLaunchAt = status.startedAt;
            if (recoveryAttempts < 3) {
              recoveryAttempts++;
              log.warn(
                `Quark startup failed; restarting Wine (${recoveryAttempts}/3)`,
              );
              await getManager().restart();
              pendingVerification = true;
            } else {
              log.error(
                "Quark startup failed after three recovery restarts; " +
                  "waiting for a manual start/restart",
              );
            }
          }
        }
      } catch (recoveryError) {
        log.warn(`Quark startup recovery failed: ${recoveryError}`);
        // A failed restart never created a new startedAt; allow the next
        // bounded attempt to retry the launch itself.
        if (recoveryAttempts < 3) failedLaunchAt = undefined;
      }
    }
    if (recoveryAttempts >= 3 && !pendingVerification) {
      // Do not let ensureQuarkAwake() keep launching indefinitely. A new
      // operator-initiated launch is identified by its start timestamp.
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_INTERVAL_MS));
        try {
          if (await autoWakeBlockReason() !== null) break;
          const status = await getManager().status();
          if (status.startedAt !== failedLaunchAt) {
            recoveryAttempts = 0;
            failedLaunchAt = undefined;
            break;
          }
        } catch {
          // manager may be restarting
        }
      }
    }
    log.debug(`Reconnecting in ${RECONNECT_INTERVAL_MS}ms...`);
    await new Promise((r) => setTimeout(r, RECONNECT_INTERVAL_MS));
  }
}
