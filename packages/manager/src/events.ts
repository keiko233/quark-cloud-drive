import type { ServerEvent } from "@quark/contract/schemas";
import type { ProcessManager } from "./process.ts";

/** Fan both manager events into a single stream without racing .next() calls. */
export async function* streamManagerEvents(
  processManager: ProcessManager,
  { signal }: { signal?: AbortSignal },
): AsyncGenerator<ServerEvent> {
  let unsubscribe: () => void;
  const stream = new ReadableStream<ServerEvent>({
    start(controller) {
      const process = processManager.events.subscribe("process", ({ state }) => {
        controller.enqueue({ type: "process", state, at: Date.now() });
      });
      const activity = processManager.events.subscribe("activity", ({ at }) => {
        controller.enqueue({ type: "activity", at });
      });
      const onAbort = () => {
        unsubscribe();
        controller.close();
      };
      unsubscribe = () => {
        process();
        activity();
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
    cancel() { unsubscribe(); },
  });
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
