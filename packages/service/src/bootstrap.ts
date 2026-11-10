import { existsSync } from "node:fs";
import { processManager, startCdpProxy } from "@quark/manager";
import { LAUNCH_SCRIPT, log, QUARK_AUTOSTART, RECONNECT_INTERVAL_MS, WINE_BIN } from "@quark/config";
import { attachStoreHooks, kvStore } from "@quark/drive";
import { autoWakeBlockReason, isCdpReachable, waitForCdpReady } from "./monitor/wake.ts";
import { startService } from "./rpc/index.ts";
import { sleeper } from "./rpc/runtime.ts";
import { connect } from "./session/connect.ts";

export interface BootstrapOptions {
  /** Skip the background renderer attach loop (API-only runs, tests). */
  attachRenderer?: boolean;
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<void> {
  await kvStore.open();
  attachStoreHooks();
  startCdpProxy({ onActivity: () => processManager.markActivity() });
  startService();
  void sleeper.start();

  if (!existsSync(WINE_BIN)) {
    log.info("Wine unavailable; running the API without a local Quark client");
    return;
  }
  if (QUARK_AUTOSTART && await autoWakeBlockReason() === null) {
    if (processManager.launchScriptAvailable()) {
      await processManager.start().catch((error) => log.error("Quark autostart failed:", error));
    } else {
      log.warn(`Quark launch script not found at "${LAUNCH_SCRIPT}"`);
    }
  }
  if (options.attachRenderer !== false) void watchRenderer();
}

/**
 * Adopt an existing client (including across dev reloads). A stopped client
 * stays stopped until a business request or an explicit start wakes it.
 */
async function watchRenderer(): Promise<void> {
  let lastLaunch: number | null | undefined;
  let retries = 0;
  while (true) {
    const state = await processManager.status();
    if (state.startedAt !== lastLaunch) {
      lastLaunch = state.startedAt;
      retries = 0;
    }
    if ((state.alive || state.state === "starting") && retries <= 3) {
      try {
        // Electron can leave the CDP port open while the HTTP server is hung.
        // Recover that case even when the existing Playwright socket still
        // reports itself as connected.
        if (!state.alive || !await isCdpReachable()) await waitForCdpReady();
        await connect();
        retries = 0;
      } catch (error) {
        log.warn("Quark session attach failed:", error);
        if (retries === 3) {
          retries++;
          log.error("Quark failed to start after three restarts; waiting for a new launch");
        } else if (await autoWakeBlockReason() === null) {
          // Don't restart a different launch or undo an idle stop.
          const current = await processManager.status();
          if (current.startedAt === state.startedAt && (current.alive || current.pid !== null || current.state === "starting")) {
            retries++;
            log.warn(`Recovering Quark startup (${retries}/3)`);
            try {
              lastLaunch = (await processManager.restart()).startedAt;
              // The last restart still needs to be checked on the next pass.
            } catch (error) {
              log.warn("Quark restart failed:", error);
            }
          }
        }
      }
    }
    await Bun.sleep(RECONNECT_INTERVAL_MS);
  }
}
