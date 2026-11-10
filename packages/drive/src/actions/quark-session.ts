import type { Page } from "playwright";
import { getHomePage } from "../browser/page-utils.ts";

import { requestInRenderer } from "../browser/renderer-http.ts";
import type { QuarkTransport } from "../api/http.ts";

/** Native downloads use the home renderer's store; no UI controls are involved. */
export async function getQuarkPage(): Promise<Page> {
  const page = getHomePage();
  await page.waitForLoadState("domcontentloaded");
  return page;
}

export function getQuarkTransport(page = getHomePage()): QuarkTransport {
  return (request) => requestInRenderer(page, request);
}
