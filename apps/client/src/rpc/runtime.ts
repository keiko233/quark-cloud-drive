// Shared runtime singletons for the client: the idle sleeper.

import {
  IDLE_CHECK_INTERVAL_MS,
  IDLE_MINIMIZE_AFTER_MS,
  IDLE_STOP_AFTER_MS,
} from "../env.ts";
import { Sleeper } from "../monitor/sleeper.ts";

export const sleeper = new Sleeper({
  minimizeAfterMs: IDLE_MINIMIZE_AFTER_MS,
  stopAfterMs: IDLE_STOP_AFTER_MS,
  checkIntervalMs: IDLE_CHECK_INTERVAL_MS,
  // A download task or CDP activity within the last 30s counts as busy.
  activityWindowMs: 30_000,
});
