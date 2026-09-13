// Turning oRPC event-iterator procedures into single plain responses.
//
// Streaming procedures (listFile, downloadFile, importShareLink) expose an
// async iterator / SSE stream so long operations can report progress. Two
// consumers want one plain JSON answer instead:
//   - MCP tools cannot represent streams; the tool returns the final value.
//   - HTTP clients that don't request `text/event-stream` get the final value
//     as JSON (Accept-header negotiation, see rpc/index.ts).
// This module is the shared machinery for both.

/** Whether a value is an async iterable (an oRPC streaming procedure output). */
export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null &&
    Symbol.asyncIterator in value;
}

/**
 * Drive an async iterator to completion and return its terminal value (the
 * second type parameter of the generator — e.g. `{path, items}` for listFile).
 */
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

/**
 * True when the Accept header explicitly asks for an SSE stream. Any other
 * value (`application/json`, a wildcard accept, or absent) prefers the plain
 * JSON response.
 */
export function wantsEventStream(accept: string): boolean {
  return accept.split(",").some((part) =>
    part.trim().toLowerCase().startsWith("text/event-stream")
  );
}

/** Whether an oRPC handler response is an SSE event-iterator stream. */
export function isEventStreamResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").startsWith(
    "text/event-stream",
  );
}

interface SseField {
  event: string;
  data?: string;
}

function parseSseBlock(block: string): SseField {
  let event = "message";
  let data: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data = line.slice("data:".length).trim();
  }
  return { event, data };
}

function findBlockSeparator(
  buffer: string,
): { index: number; length: number } {
  const lf = buffer.indexOf("\n\n");
  if (lf !== -1) return { index: lf, length: 2 };
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1) return { index: crlf, length: 4 };
  return { index: -1, length: 0 };
}

/**
 * Consume an oRPC SSE body and return the `done` event payload - the final
 * value of the underlying generator. Throws when the stream reports an
 * `error` event. Comment-only (keep-alive) blocks are ignored.
 */
export async function consumeEventIteratorSSE(
  body: ReadableStream<Uint8Array> | null,
): Promise<unknown> {
  if (!body) throw new Error("streaming response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalValue: unknown;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = findBlockSeparator(buffer);
    while (separator.index !== -1) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const field = parseSseBlock(block);
      if (field.event === "done" && field.data !== undefined) {
        finalValue = JSON.parse(field.data);
      } else if (field.event === "error") {
        const data = JSON.parse(field.data ?? "{}") as { message?: unknown };
        throw new Error(
          typeof data.message === "string" ? data.message : "stream error",
        );
      }
      separator = findBlockSeparator(buffer);
    }
  }
  return finalValue;
}
