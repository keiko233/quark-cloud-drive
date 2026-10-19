// Shared runtime singletons for the client: the idle sleeper.

import { Sleeper } from "../monitor/sleeper.ts";

// Configuration is loaded from the KV store by Sleeper on every cycle. This
// makes PATCH /config effective without restarting the client container.
export const sleeper = new Sleeper();
