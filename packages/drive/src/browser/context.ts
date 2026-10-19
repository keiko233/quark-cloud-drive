// Browser handle singleton + the shared operation queue. All Playwright
// actions run through the single-slot OperationQueue because they share the
// one Quark window.

import type { Browser } from "playwright";
import { OperationQueue } from "../queue/operation-queue.ts";

let _browser: Browser | null = null;

const operationQueue = new OperationQueue();

export function setBrowser(browser: Browser | null): void {
  _browser = browser;
}

export function getBrowser(): Browser {
  if (!_browser) {
    throw new Error("Browser is not connected");
  }
  return _browser;
}

export function getOperationQueue(): OperationQueue {
  return operationQueue;
}
