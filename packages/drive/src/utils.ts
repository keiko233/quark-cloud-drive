import type { BrowserContext, Page } from "playwright";

function normalizeUccdUrl(url: string): string {
  return url
    .replace(/^uccd:\/\/[^/]+\/?/, "")
    .replace(/^\.\.\//, "");
}

function matchPageUrl(pageUrl: string, targetUrl: string): boolean {
  const pagePath = normalizeUccdUrl(pageUrl);
  const targetPath = normalizeUccdUrl(targetUrl);

  return pageUrl.startsWith(targetUrl) ||
    pagePath.startsWith(targetPath) ||
    pagePath.endsWith(targetPath);
}

export function findPageByUrl(
  context: BrowserContext,
  targetUrl: string | readonly string[],
): Page | undefined {
  const targetUrls = Array.isArray(targetUrl) ? targetUrl : [targetUrl];
  return context.pages().find((page) =>
    targetUrls.some((targetUrl) => matchPageUrl(page.url(), targetUrl))
  );
}
