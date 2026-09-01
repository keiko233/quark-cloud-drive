// apps/client entrypoint — orchestration + business + monitoring.

import { log } from "./logger.ts";
import { CDP_URL, RECONNECT_INTERVAL_MS, SERVER_URL } from "./env.ts";
import { startServer } from "./rpc/index.ts";
import { connect } from "./browser/connect.ts";
import { sleeper } from "./rpc/runtime.ts";

log.debug("Quark Remote Client started");
log.debug(`CDP URL: ${CDP_URL}`);
log.debug(`Server URL: ${SERVER_URL}`);

startServer();
sleeper.start();

while (true) {
  try {
    await connect();
  } catch (err) {
    log.error("ERROR:", err);
  }
  log.debug(`Reconnecting in ${RECONNECT_INTERVAL_MS}ms...`);
  await new Promise((r) => setTimeout(r, RECONNECT_INTERVAL_MS));
}
