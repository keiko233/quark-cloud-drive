import { assertEquals, assertRejects } from "@std/assert";
import {
  ByteBuffer,
  frameClient,
  frameServer,
  readFrame,
} from "./cdp-proxy.ts";

function bufferFrom(concat: Uint8Array): ByteBuffer {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(concat);
      controller.close();
    },
  });
  return new ByteBuffer(stream.getReader());
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

Deno.test("frameServer round-trips through readFrame", async () => {
  const payload = utf8("hello world");
  const frame = frameServer(payload, 1);
  const buf = bufferFrom(frame);
  const got = await readFrame(buf);
  assertEquals(got?.opcode, 1);
  assertEquals(new TextDecoder().decode(got?.payload), "hello world");
});

Deno.test("frameClient round-trips through readFrame (unmasking)", async () => {
  const payload = utf8('{"id":1,"method":"Runtime.evaluate"}');
  const frame = frameClient(payload, 1);
  const buf = bufferFrom(frame);
  const got = await readFrame(buf);
  assertEquals(got?.opcode, 1);
  assertEquals(
    new TextDecoder().decode(got?.payload),
    '{"id":1,"method":"Runtime.evaluate"}',
  );
});

Deno.test("frameServer handles extended 16-bit length", async () => {
  // 126-byte payload forces the 16-bit extended length path.
  const payload = new Uint8Array(126).fill(0x41);
  const frame = frameServer(payload, 1);
  const buf = bufferFrom(frame);
  const got = await readFrame(buf);
  if (got === null) throw new Error("expected a frame");
  assertEquals(got.payload.length, 126);
  assertEquals(got.payload[0], 0x41);
});

Deno.test("frameServer handles 64-bit length path", async () => {
  const payload = new Uint8Array(70000).fill(0x42);
  const frame = frameServer(payload, 2);
  const buf = bufferFrom(frame);
  const got = await readFrame(buf);
  if (got === null) throw new Error("expected a frame");
  assertEquals(got.opcode, 2);
  assertEquals(got.payload.length, 70000);
  assertEquals(got.payload[69999], 0x42);
});

Deno.test("close frame opcode 8 passes through", async () => {
  const payload = new Uint8Array([0x03, 0xe8]); // close code 1000
  const frame = frameServer(payload, 8);
  const buf = bufferFrom(frame);
  const got = await readFrame(buf);
  assertEquals(got?.opcode, 8);
  assertEquals(got?.payload.length, 2);
});

Deno.test("multiple frames in a single chunk are read sequentially", async () => {
  const a = frameServer(utf8("alpha"), 1);
  const b = frameServer(utf8("beta"), 1);
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a);
  combined.set(b, a.length);
  const buf = bufferFrom(combined);
  const first = await readFrame(buf);
  const second = await readFrame(buf);
  assertEquals(new TextDecoder().decode(first?.payload), "alpha");
  assertEquals(new TextDecoder().decode(second?.payload), "beta");
});

Deno.test("readFrame returns null at clean EOF", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const buf = new ByteBuffer(stream.getReader());
  const got = await readFrame(buf);
  assertEquals(got, null);
});

Deno.test("readFrame throws on truncated frame", async () => {
  // A 2-byte header declaring a 10-byte payload but with only 3 bytes total.
  const partial = frameServer(utf8("abcdefghij"), 1).subarray(0, 5);
  const buf = bufferFrom(partial);
  await assertRejects(
    () => readFrame(buf),
    Error,
    "truncated frame payload",
  );
});
