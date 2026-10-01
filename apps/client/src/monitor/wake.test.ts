import { assertEquals } from "@std/assert";
import { kvStore } from "../store/kv.ts";
import {
  clearLoggedOutStopMarker,
  clearManualStop,
  isManualStopActive,
  markManualStop,
} from "./status.ts";
import { autoWakeBlockReason, isAutoWakeBlocked } from "./wake.ts";

Deno.test("an explicit stop suppresses auto-wake until it is cleared", async () => {
  await kvStore.open();
  await clearManualStop();
  await clearLoggedOutStopMarker();

  assertEquals(await isManualStopActive(), false);
  assertEquals(await autoWakeBlockReason(), null);
  assertEquals(await isAutoWakeBlocked(), false);

  // /manager/stop arms the marker: the reconnect loop must not undo it.
  await markManualStop();
  assertEquals(await isManualStopActive(), true);
  assertEquals(
    await autoWakeBlockReason(),
    "Quark was stopped explicitly; POST /manager/start to wake it",
  );
  assertEquals(await isAutoWakeBlocked(), true);

  // /manager/start (or /manager/restart) clears it again.
  await clearManualStop();
  assertEquals(await isManualStopActive(), false);
  assertEquals(await isAutoWakeBlocked(), false);
});
