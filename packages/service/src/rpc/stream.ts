// Helpers for the one place a streaming procedure can still surface: MCP tools
// cannot represent an async iterable, so the bridge consumes it and returns the
// terminal value. Business procedures are plain JSON now, so this is defensive.

/** Whether a value is an async iterable (an oRPC streaming procedure output). */
export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null &&
    Symbol.asyncIterator in value;
}

/** Drive an async iterator to completion and return its terminal value. */
export async function consumeAsyncIterableFinal<TYield, TReturn>(
  iterable: AsyncIterable<TYield>,
): Promise<TReturn> {
  const iterator = iterable[Symbol.asyncIterator]();
  let final!: TReturn;
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      final = step.value;
      break;
    }
  }
  return final;
}
