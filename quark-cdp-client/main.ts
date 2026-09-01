import { log } from "./libs/logger.ts";
import {
  CDP_URL,
  QUARK_MANAGER_URL,
  RECONNECT_INTERVAL_MS,
} from "./libs/env.ts";
import { waitForManagerReady } from "./libs/manager.ts";
import { startServer } from "./server/index.ts";
import { connect } from "./client/connect.ts";

log.debug("Quark Remote Client started");
log.debug(`CDP URL: ${CDP_URL}`);
log.debug(`Manager URL: ${QUARK_MANAGER_URL}`);

// Block boot on the manager being reachable — every codepath (connect loop,
// per-request wake middleware, /manager passthrough) assumes it. Failing fast
// here surfaces misconfigured QUARK_MANAGER_URL before requests start arriving.
await waitForManagerReady();
log.debug("manager reachable, starting HTTP server and connect loop");

startServer();

while (true) {
  try {
    await connect();
  } catch (err) {
    log.error("ERROR:", err);
  }
  log.debug(`Reconnecting in ${RECONNECT_INTERVAL_MS}ms...`);
  await new Promise((r) => setTimeout(r, RECONNECT_INTERVAL_MS));
}
