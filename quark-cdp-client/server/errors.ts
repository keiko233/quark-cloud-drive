import { ORPCError, os } from "@orpc/server";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error) {
    return error;
  }

  return "Internal Server Error";
}

export const baseProcedure = os
  .errors({
    INTERNAL_SERVER_ERROR: {
      status: 500,
      message: "Internal Server Error",
    },
    NOT_FOUND: {
      status: 404,
      message: "Not Found",
    },
  })
  .use(async ({ next, errors }) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw errors.INTERNAL_SERVER_ERROR({
        message: getErrorMessage(error),
        cause: error instanceof Error ? error : undefined,
      });
    }
  });
