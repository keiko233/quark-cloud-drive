// @quark/service — the composition root.
//
// One process owns the whole app: the process manager (embedded, or remote
// over HTTP), the CDP proxy, the manager API, the public API surface, the idle
// monitor, and the renderer attach loop. The entrypoint in app only calls
// this and nothing else.

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
} from "@quark/config";
import { attachStoreHooks, kvStore } from "@quark/drive";
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

  if (MANAGER_MODE === "http") {
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
    autostart(processManager);
  }

  startService();
  sleeper.start();

  if (options.attachRenderer !== false) {
    void attachLoop();
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
  while (true) {
    try {
      await connect();
    } catch (err) {
      log.error("ERROR:", err);
    }
    log.debug(`Reconnecting in ${RECONNECT_INTERVAL_MS}ms...`);
    await new Promise((r) => setTimeout(r, RECONNECT_INTERVAL_MS));
  }
}
