// Shared runtime singletons for the client: the idle sleeper.

import { Sleeper } from "../monitor/sleeper.ts";

// Configuration is loaded from Deno KV by Sleeper on every cycle. This makes
// PATCH /config effective without restarting the client container.
export const sleeper = new Sleeper();
