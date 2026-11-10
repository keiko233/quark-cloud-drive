import type { Page } from "playwright";
import {
  DEFAULT_QUARK_TIMEOUT_MS,
  QuarkApiError,
  type QuarkHttpResponse,
  type QuarkRequest,
} from "../api/http.ts";

const RENDERER_HEADERS = { accept: "application/json, text/plain, */*" };

/** Use the app's network stack and authenticated cookie jar without DOM access. */
export async function requestInRenderer(
  page: Page,
  request: QuarkRequest,
): Promise<QuarkHttpResponse> {
  const { method = "GET", url, body, timeoutMs = DEFAULT_QUARK_TIMEOUT_MS } =
    request;
  const headers = body === undefined
    ? RENDERER_HEADERS
    : { ...RENDERER_HEADERS, "content-type": "application/json" };

  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = page.evaluate(
      async ({ method, url, body, timeoutMs, headers }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            method,
            credentials: "include",
            cache: "no-store",
            headers,
            ...(body === null ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
          });
          return { status: response.status, text: await response.text() };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        method,
        url,
        body: body ?? null,
        timeoutMs,
        headers,
      },
    );
    // The timeout in the renderer cannot fire if Electron's event loop hangs.
    // Keep the host operation queue moving without retrying an uncertain write.
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          reject(new QuarkApiError("Quark renderer did not answer before the request deadline"));
        }, timeoutMs + 500);
      }),
    ]);
  } catch (error) {
    if (error instanceof QuarkApiError) throw error;
    throw new QuarkApiError("renderer request failed");
  } finally {
    clearTimeout(deadline);
  }
}
