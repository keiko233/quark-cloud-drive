import { assertEquals, assertRejects } from "@jsr/std__assert";
import { test } from "bun:test";
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

test("frameServer round-trips through readFrame", async () => {
  const payload = utf8("hello world");
  const frame = frameServer(payload, 1);
  const buf = bufferFrom(frame);
  const got = await readFrame(buf);
  assertEquals(got?.opcode, 1);
  assertEquals(new TextDecoder().decode(got?.payload), "hello world");
});

test("frameClient round-trips through readFrame (unmasking)", async () => {
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

test("frameServer handles extended 16-bit length", async () => {
  // 126-byte payload forces the 16-bit extended length path.
  const payload = new Uint8Array(126).fill(0x41);
  const frame = frameServer(payload, 1);
  const buf = bufferFrom(frame);
  const got = await readFrame(buf);
  if (got === null) throw new Error("expected a frame");
  assertEquals(got.payload.length, 126);
  assertEquals(got.payload[0], 0x41);
});

test("frameServer handles 64-bit length path", async () => {
  const payload = new Uint8Array(70000).fill(0x42);
  const frame = frameServer(payload, 2);
  const buf = bufferFrom(frame);
  const got = await readFrame(buf);
  if (got === null) throw new Error("expected a frame");
  assertEquals(got.opcode, 2);
  assertEquals(got.payload.length, 70000);
  assertEquals(got.payload[69999], 0x42);
});

test("frameClient has no trailing bytes (exact header+mask+payload)", async () => {
  // Regression: headerLength(..., true) already includes the mask, so the
  // frame must NOT add another +4. Extra trailing zero bytes get parsed as a
  // garbage second frame by the peer (Chromium closes the CDP WS with 1006).
  const payload = utf8('{"id":1,"method":"Runtime.evaluate"}');
  const frame = frameClient(payload, 1);
  const expected = 2 + 4 + payload.length;
  assertEquals(frame.length, expected);

  // The frame must be a single well-formed masked frame: header declares the
  // full length, then exactly the mask and payload.
  const buf = bufferFrom(frame);
  const got = await readFrame(buf);
  assertEquals(got?.opcode, 1);
  assertEquals(
    new TextDecoder().decode(got?.payload),
    '{"id":1,"method":"Runtime.evaluate"}',
  );
  // And nothing may be left over for a second frame.
  assertEquals(await readFrame(buf), null);
});

test("frameServer has no trailing bytes", async () => {
  const payload = utf8("ok");
  const frame = frameServer(payload, 1);
  assertEquals(frame.length, 2 + payload.length);
  const buf = bufferFrom(frame);
  const got = await readFrame(buf);
  assertEquals(new TextDecoder().decode(got?.payload), "ok");
  assertEquals(await readFrame(buf), null);
});

test("close frame opcode 8 passes through", async () => {
  const payload = new Uint8Array([0x03, 0xe8]); // close code 1000
  const frame = frameServer(payload, 8);
  const buf = bufferFrom(frame);
  const got = await readFrame(buf);
  assertEquals(got?.opcode, 8);
  assertEquals(got?.payload.length, 2);
});

test("multiple frames in a single chunk are read sequentially", async () => {
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

test("readFrame returns null at clean EOF", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const buf = new ByteBuffer(stream.getReader());
  const got = await readFrame(buf);
  assertEquals(got, null);
});

test("readFrame throws on truncated frame", async () => {
  // A 2-byte header declaring a 10-byte payload but with only 3 bytes total.
  const partial = frameServer(utf8("abcdefghij"), 1).subarray(0, 5);
  const buf = bufferFrom(partial);
  await assertRejects(
    () => readFrame(buf),
    Error,
    "truncated frame payload",
  );
});
