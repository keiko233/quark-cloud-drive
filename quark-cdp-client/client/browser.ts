import type { Browser } from "playwright";
import PQueue from "p-queue";
import { log } from "../libs/logger.ts";
import type { BrowserQueueStatus } from "../libs/schemas.ts";

let _browser: Browser | null = null;
const queue = new PQueue({ concurrency: 1 });
let activeBrowserOperationLabel: string | null = null;

export type { BrowserQueueStatus };

export function setBrowser(browser: Browser | null): void {
  _browser = browser;
}

export function getBrowser(): Browser {
  if (!_browser) {
    throw new Error("Browser is not connected");
  }
  return _browser;
}

export function getBrowserQueueStatus(): BrowserQueueStatus {
  const running = activeBrowserOperationLabel !== null;
  return {
    running,
    current: activeBrowserOperationLabel,
    queued: queue.size,
    total: queue.size + (running ? 1 : 0),
  };
}

export async function enqueueBrowserOperation<T>(
  operation: () => Promise<T>,
  label = "anonymous",
): Promise<T> {
  log.trace(`queue enqueue: ${label} (waiting: ${queue.size})`);
  return queue.add(async () => {
    activeBrowserOperationLabel = label;
    log.trace(`queue start: ${label}`);
    const t0 = Date.now();
    try {
      return await operation();
    } catch (e) {
      log.debug(`queue error: ${label}: ${(e as Error).message}`);
      throw e;
    } finally {
      activeBrowserOperationLabel = null;
      log.trace(`queue end: ${label} (${Date.now() - t0}ms)`);
    }
  }) as Promise<T>;
}
