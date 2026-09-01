// Wake-on-request Hono middleware: ensure Quark is awake (process running +
// CDP reachable + browser connected) before forwarding the request to the
// oRPC handler. This is what makes the manager's idle-stop policy invisible
// to API consumers — they get a one-time cold-start delay on the first
// request after idle, then snappy responses.
//
// Skipped for:
//   - /manager-*    — these ARE the wake control surface; calling them must
//                     never recurse into ensureQuarkAwake (and /manager-stop
//                     explicitly wants Quark down). NOTE: the prefix is the
//                     dash form `/manager-`, not `/manager/`. Any future
//                     manager passthrough route must follow `/manager-<verb>`
//                     so this single prefix check keeps catching them.
//   - /spec.json,
//     /openapi.json,
//     /,             — oRPC OpenAPI reference UI; metadata only
//   - OPTIONS        — CORS preflight, no business logic runs
//
// MCP (/mcp) and every business route triggers a wake. Within a single wake
// window, parallel callers share the in-flight promise (see libs/manager.ts).
import type { Context, Next } from "hono";
import { ensureQuarkAwake } from "../libs/manager.ts";
import { log } from "../libs/logger.ts";

const SKIP_PREFIXES = [
  "/manager-",
  "/spec.json",
  "/openapi.json",
];

const SKIP_EXACT = new Set(["/"]);

function shouldSkip(path: string, method: string): boolean {
  if (method === "OPTIONS") return true;
  if (SKIP_EXACT.has(path)) return true;
  return SKIP_PREFIXES.some((p) => path.startsWith(p));
}

export async function wakeOnRequest(c: Context, next: Next): Promise<void | Response> {
  const path = c.req.path;
  const method = c.req.method;
  if (shouldSkip(path, method)) {
    return next();
  }

  try {
    await ensureQuarkAwake();
  } catch (err) {
    log.error("ensureQuarkAwake failed:", err);
    return c.json(
      {
        error: "quark_unavailable",
        message: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }
  await next();
}
