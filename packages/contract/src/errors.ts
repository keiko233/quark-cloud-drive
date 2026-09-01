import type { ErrorMap } from "@orpc/contract";

/**
 * Shared error map for both contracts. The implementers (apps/server and
 * apps/client) use `errors.INTERNAL_SERVER_ERROR` etc. in their error-handling
 * middleware, and clients can catch these by code.
 */
export const sharedErrorMap = {
  INTERNAL_SERVER_ERROR: {
    status: 500,
    message: "Internal Server Error",
  },
  NOT_FOUND: {
    status: 404,
    message: "Not Found",
  },
} satisfies ErrorMap;
