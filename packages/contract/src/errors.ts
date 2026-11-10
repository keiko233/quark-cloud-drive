import type { ErrorMap } from "@orpc/contract";

/**
 * Errors shared by the REST and MCP adapters. The service use `errors.INTERNAL_SERVER_ERROR` etc. in their error-handling
 * middleware, and clients can catch these by code.
 */
export const sharedErrorMap = {
  INTERNAL_SERVER_ERROR: {
    status: 500,
    message: "Internal Server Error",
  },
  UNAUTHORIZED: { status: 401, message: "Quark sign-in required" },
  BAD_GATEWAY: { status: 502, message: "Quark API request failed" },
  NOT_FOUND: {
    status: 404,
    message: "Not Found",
  },
  FORBIDDEN: {
    status: 403,
    message: "Operation blocked by guard",
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "Service is not ready",
  },
} satisfies ErrorMap;
