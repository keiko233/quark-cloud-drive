import { assertEquals, assertRejects } from "@std/assert";
import {
  consumeAsyncIterableFinal,
  consumeEventIteratorSSE,
  isAsyncIterable,
  wantsEventStream,
} from "./stream.ts";

Deno.test("consumeAsyncIterableFinal returns the generator's terminal value", async () => {
  const gen = (async function* () {
    yield { type: "status", message: "click 首页" };
    yield { type: "collecting", seen: 3, total: 0 };
    return { path: [], items: [{ name: "x" }] };
  })();
  assertEquals(await consumeAsyncIterableFinal(gen), {
    path: [],
    items: [{ name: "x" }],
  });
});

Deno.test("consumeEventIteratorSSE returns the done payload", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: message\ndata: {"type":"status","message":"a"}\n\n',
      ));
      controller.enqueue(encoder.encode(
        'event: done\ndata: {"path":["d"],"items":[{"name":"a"}]}\n\n',
      ));
      controller.close();
    },
  });
  assertEquals(await consumeEventIteratorSSE(body), {
    path: ["d"],
    items: [{ name: "a" }],
  });
});

Deno.test("consumeEventIteratorSSE ignores comment/keep-alive blocks", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(":\n\n"));
      controller.enqueue(encoder.encode(
        'event: done\ndata: {"path":[]}\n\n',
      ));
      controller.close();
    },
  });
  assertEquals(await consumeEventIteratorSSE(body), { path: [] });
});

Deno.test("consumeEventIteratorSSE handles CRLF line endings", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: done\r\ndata: {"path":[]}\r\n\r\n',
      ));
      controller.close();
    },
  });
  assertEquals(await consumeEventIteratorSSE(body), { path: [] });
});

Deno.test("consumeEventIteratorSSE throws on the error event", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: error\ndata: {"message":"boom"}\n\n',
      ));
      controller.close();
    },
  });
  await assertRejects(() => consumeEventIteratorSSE(body), Error, "boom");
});

Deno.test("consumeEventIteratorSSE rejects when body is missing", async () => {
  await assertRejects(
    () => consumeEventIteratorSSE(null),
    Error,
    "no body",
  );
});

Deno.test("wantsEventStream parses the Accept header", () => {
  assertEquals(wantsEventStream("text/event-stream"), true);
  assertEquals(wantsEventStream("text/event-stream, application/json"), true);
  assertEquals(wantsEventStream("application/json"), false);
  assertEquals(wantsEventStream("application/json, */*"), false);
  assertEquals(wantsEventStream("*/*"), false);
  assertEquals(wantsEventStream(""), false);
});

Deno.test("isAsyncIterable distinguishes generators from plain values", () => {
  assertEquals(isAsyncIterable(null), false);
  assertEquals(isAsyncIterable({}), false);
  assertEquals(isAsyncIterable([]), false);
  assertEquals(isAsyncIterable(async function* () {}()), true);
});
