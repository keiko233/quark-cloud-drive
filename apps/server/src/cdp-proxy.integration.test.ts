// End-to-end CDP proxy test against a fake Quark server. Verifies:
//   1. HTTP /json/* proxy with ws:// URL rewrite
//   2. WebSocket handshake + bidirectional frame relay
//   3. Browser.* intercept returns fake success and does NOT reach Quark
import { assertEquals } from "@std/assert";
import {
  ByteBuffer,
  frameClient,
  frameServer,
  readFrame,
  startCdpProxy,
} from "./cdp-proxy.ts";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

async function wsAccept(key: string): Promise<string> {
  const data = new TextEncoder().encode(
    key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
  );
  const digest = await crypto.subtle.digest(
    "SHA-1",
    data.buffer as ArrayBuffer,
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** A fake Quark: serves /json/list and a WS endpoint that echoes CDP responses. */
function startFakeQuark(): {
  port: number;
  close: () => void;
  received: string[];
} {
  const received: string[] = [];
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;

  const serve = async () => {
    for await (const conn of listener) {
      (async () => {
        const buf = new ByteBuffer(conn.readable.getReader());
        const head = await readHttpHeadForTest(buf);
        if (head.path.startsWith("/json/")) {
          const body = utf8(
            JSON.stringify([{
              url: "http://example.com/",
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1`,
            }]),
          );
          const w = conn.writable.getWriter();
          await w.write(
            utf8(
              `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
            ),
          );
          await w.write(body);
          w.releaseLock();
          conn.close();
          return;
        }
        if (head.headers["upgrade"] === "websocket") {
          const accept = await wsAccept(
            head.headers["sec-websocket-key"] ?? "",
          );
          const w = conn.writable.getWriter();
          await w.write(utf8(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          ));
          w.releaseLock();
          // echo replies to text frames, record what we see
          try {
            for (;;) {
              const frame = await readFrame(buf);
              if (!frame) break;
              if (frame.opcode === 8) break;
              if (frame.opcode === 1) {
                const text = decode(frame.payload);
                received.push(text);
                const msg = JSON.parse(text) as { id: number };
                const reply = JSON.stringify({
                  id: msg.id,
                  result: { ok: true },
                });
                await conn.writable.getWriter().write(frameServer(utf8(reply)));
              }
            }
          } catch {
            // dropped
          }
          try {
            conn.close();
          } catch {
            // already closed
          }
          return;
        }
        conn.close();
      })().catch(() => conn.close());
    }
  };
  serve();

  return {
    port,
    close: () => listener.close(),
    received,
  };
}

async function readHttpHeadForTest(
  buf: ByteBuffer,
): Promise<{ path: string; headers: Record<string, string> }> {
  let raw = "";
  for (;;) {
    const line = await buf.read(1);
    if (!line) break;
    raw += String.fromCharCode(line[0]);
    if (raw.endsWith("\r\n\r\n")) break;
  }
  const lines = raw.split("\r\n").filter((l) => l.length > 0);
  const parts = lines[0]?.split(" ") ?? [];
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1)
        .trim();
    }
  }
  return { path: parts[1] ?? "/", headers };
}

function connect(port: number): Promise<Deno.Conn> {
  return Deno.connect({ hostname: "127.0.0.1", port });
}

async function readHttpResponse(
  conn: Deno.Conn,
): Promise<{ status: string; headers: Record<string, string>; body: string }> {
  const buf = new ByteBuffer(conn.readable.getReader());
  const head = await readHttpHeadForTest(buf);
  const headers = head.headers;
  const len = Number(headers["content-length"] ?? "0");
  let body = "";
  if (len > 0) {
    const bytes = await buf.read(len);
    if (bytes) body = decode(bytes);
  }
  return { status: head.path === "" ? "" : "", headers, body };
}

Deno.test("CDP proxy: /json/list proxies with ws URL rewrite", async () => {
  const fake = startFakeQuark();
  const proxy = startCdpProxy({ quarkPort: fake.port, proxyPort: 0 });
  try {
    const conn = await connect(proxy.port);
    await conn.write(utf8(
      "GET /json/list HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${proxy.port}\r\n` +
        "Connection: close\r\n\r\n",
    ));
    const resp = await readHttpResponse(conn);
    conn.close();
    const data = JSON.parse(resp.body) as Array<
      { webSocketDebuggerUrl: string }
    >;
    assertEquals(
      data[0].webSocketDebuggerUrl,
      `ws://127.0.0.1:${proxy.port}/devtools/page/1`,
    );
  } finally {
    proxy.close();
    fake.close();
  }
});

Deno.test("CDP proxy: WS relay forwards frames and returns responses", async () => {
  const fake = startFakeQuark();
  const proxy = startCdpProxy({ quarkPort: fake.port, proxyPort: 0 });
  try {
    const conn = await connect(proxy.port);
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    await conn.write(utf8(
      "GET /devtools/page/1 HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${proxy.port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    ));
    const buf = new ByteBuffer(conn.readable.getReader());
    // consume 101
    await readHttpHeadForTest(buf);

    // send a normal command — expect the fake quark's reply relayed back
    await conn.write(
      frameClient(utf8('{"id":1,"method":"Runtime.evaluate","params":{}}'), 1),
    );
    const reply = await readFrame(buf);
    assertEquals(decode(reply!.payload), '{"id":1,"result":{"ok":true}}');

    conn.close();
  } finally {
    proxy.close();
    fake.close();
  }
});

Deno.test("CDP proxy: Browser.* commands are intercepted, not forwarded", async () => {
  const fake = startFakeQuark();
  const proxy = startCdpProxy({ quarkPort: fake.port, proxyPort: 0 });
  try {
    const conn = await connect(proxy.port);
    await conn.write(utf8(
      "GET /devtools/page/1 HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${proxy.port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: bm9uY2U=\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    ));
    const buf = new ByteBuffer(conn.readable.getReader());
    await readHttpHeadForTest(buf);

    await conn.write(
      frameClient(
        utf8('{"id":42,"method":"Browser.setDownloadBehavior","params":{}}'),
        1,
      ),
    );
    const reply = await readFrame(buf);

    // The client must get the proxy-synthesized empty success, and the
    // command must never reach the fake Quark.
    assertEquals(decode(reply!.payload), '{"id":42,"result":{}}');

    await new Promise((r) => setTimeout(r, 200));
    assertEquals(
      fake.received.length,
      0,
      "intercepted command must not reach Quark",
    );

    conn.close();
  } finally {
    proxy.close();
    fake.close();
  }
});
