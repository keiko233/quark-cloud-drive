import type { Page } from "playwright";

/**
 * Transport for Quark's business JSON API.
 *
 * Every call runs as a same-origin `fetch` inside the logged-in renderer, so
 * Quark's session cookie is applied automatically. This module never reads,
 * copies, logs, or persists the cookie, an `Authorization` header, or any URL
 * the renderer resolves — it only forwards the request and returns the body.
 */

export const QUARK_API_ORIGIN = "https://drive-pc.quark.cn";

/**
 * Query parameters Quark's API requires on every business call. Without
 * `pr`/`fr` the server answers `401 {"code":31001,"message":"require login"}`
 * even for a fully authenticated session.
 */
export const QUARK_BASE_PARAMS: Readonly<Record<string, string>> = {
  pr: "ucpro",
  fr: "pc",
};

export const DEFAULT_QUARK_TIMEOUT_MS = 8_000;

const RENDERER_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
};

type JsonObject = Record<string, unknown>;

export class QuarkApiError extends Error {
  /** Quark's business error code, when the response carried one. */
  readonly code: number | null;
  /** HTTP status, when the failure was transport-level. */
  readonly status: number | null;

  constructor(
    message: string,
    options: { code?: number | null; status?: number | null } = {},
  ) {
    super(message);
    this.name = "QuarkApiError";
    this.code = options.code ?? null;
    this.status = options.status ?? null;
  }
}

/** Whether Quark answered "not logged in" (HTTP 401 / code `31001`). */
export function isQuarkLoginError(error: unknown): boolean {
  if (!(error instanceof QuarkApiError)) return false;
  return error.status === 401 || error.code === 31001 || error.code === 31004;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asObjectOrNull(value: unknown): JsonObject | null {
  return asObject(value);
}

/** Build an absolute Quark API URL from a `/1/clouddrive/...` path. */
export function buildQuarkApiUrl(
  path: string,
  params: Record<string, string | number | undefined> = {},
): string {
  const url = new URL(path, QUARK_API_ORIGIN);
  const search = new URLSearchParams(QUARK_BASE_PARAMS);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  url.search = search.toString();
  return url.toString();
}

export interface RendererRequest {
  method?: "GET" | "POST";
  url: string;
  body?: unknown;
  timeoutMs?: number;
}

export interface RendererHttpResponse {
  status: number;
  text: string;
}

/**
 * Issue one request from the renderer and return the raw response text.
 * Never throws on a non-2xx status; callers decide what a status means.
 */
export async function requestInRenderer(
  page: Page,
  request: RendererRequest,
): Promise<RendererHttpResponse> {
  const { method = "GET", url, body, timeoutMs = DEFAULT_QUARK_TIMEOUT_MS } =
    request;
  const headers = body === undefined
    ? RENDERER_HEADERS
    : { ...RENDERER_HEADERS, "content-type": "application/json" };

  try {
    return await page.evaluate(
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
  } catch {
    throw new QuarkApiError("renderer request failed");
  }
}

/** Parse a response body as JSON, or throw a `QuarkApiError`. */
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new QuarkApiError("Quark API response was not JSON");
  }
}

export interface QuarkEnvelope {
  code: number;
  message: string;
  data: unknown;
  metadata: JsonObject;
}

/**
 * Validate Quark's `{code, message, data, metadata}` envelope. A non-zero
 * `code` (or `"OK"`-style success marker) is normalized to `code: 0`.
 */
export function parseQuarkEnvelope(payload: unknown): QuarkEnvelope {
  const root = asObject(payload);
  if (!root) throw new QuarkApiError("Quark API returned invalid JSON");

  const rawCode = root.code;
  const code = readFiniteNumber(rawCode) ??
    (typeof rawCode === "string" && /^ok$/i.test(rawCode) ? 0 : NaN);
  if (!Number.isFinite(code)) {
    throw new QuarkApiError("Quark API response had no status code");
  }
  if (code !== 0) {
    const message = readString(root.message) ?? `code ${code}`;
    throw new QuarkApiError(`Quark API error: ${message}`, { code });
  }

  return {
    code: 0,
    message: readString(root.message) ?? "",
    data: root.data,
    metadata: asObject(root.metadata) ?? {},
  };
}

/**
 * Issue one request and return the validated envelope. Throws
 * `QuarkApiError` for transport failures, non-200 responses, and Quark
 * business errors.
 */
export async function requestQuarkApi(
  page: Page,
  request: RendererRequest,
): Promise<QuarkEnvelope> {
  let response: RendererHttpResponse;
  try {
    response = await requestInRenderer(page, request);
  } catch (error) {
    throw error instanceof QuarkApiError
      ? error
      : new QuarkApiError("renderer request failed");
  }

  if (response.status !== 200) {
    let code: number | null = null;
    let message = `Quark API returned HTTP ${response.status}`;
    try {
      const body = asObject(JSON.parse(response.text));
      code = readFiniteNumber(body?.code) ?? null;
      const bodyMessage = readString(body?.message);
      if (bodyMessage) message = bodyMessage;
    } catch {
      // Non-JSON error body; keep the HTTP-derived message.
    }
    throw new QuarkApiError(message, { code, status: response.status });
  }

  return parseQuarkEnvelope(parseJsonText(response.text));
}
