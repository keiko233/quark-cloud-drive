// @quark/manager — process event fan-out shared by the embedded manager and
// the service's `/manager/events` route.

import type { ServerEvent } from "@quark/contract/schemas";
import type { ProcessManager } from "./process.ts";

/**
 * Convert the manager's internal event bus into the contracted `ServerEvent`
 * stream. Shared by the in-process facade and the HTTP route so both observe
 * exactly the same events.
 */
export async function* streamManagerEvents(
  processManager: ProcessManager,
  { signal }: { signal?: AbortSignal },
): AsyncGenerator<ServerEvent> {
  const processIt = processManager.events.subscribe("process", { signal });
  const activityIt = processManager.events.subscribe("activity", { signal });
  try {
    while (true) {
      const next = await Promise.race([
        processIt.next().then((r) => ({ from: "process" as const, r })),
        activityIt.next().then((r) => ({ from: "activity" as const, r })),
      ]);
      if (next.r.done) break;
      if (next.from === "process") {
        yield { type: "process", state: next.r.value.state, at: Date.now() };
      } else {
        yield { type: "activity", at: next.r.value.at };
      }
    }
  } finally {
    await processIt.return?.(undefined);
    await activityIt.return?.(undefined);
  }
}
