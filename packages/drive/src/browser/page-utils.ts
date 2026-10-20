import type { BrowserContext, Page } from "playwright";
import { getBrowser } from "./context.ts";
import { findPageByUrl } from "../utils.ts";
import { QUARK_HOME_PAGE_URL } from "../consts.ts";
import { log } from "@quark/config";

export function getBrowserContext(): BrowserContext {
  const context = getBrowser().contexts()[0];
  if (!context) throw new Error("No BrowserContext found");
  return context;
}

export function getHomePage(): Page {
  const context = getBrowserContext();
  const page = findPageByUrl(context, QUARK_HOME_PAGE_URL);
  if (!page) throw new Error(`Home page not found: ${QUARK_HOME_PAGE_URL}`);
  log.trace(`getHomePage: found page url=${page.url()}`);
  return page;
}
