// Transparent CDP proxy: listen on 0.0.0.0:<proxyPort>, forward to
// 127.0.0.1:<quarkPort>. Handles both HTTP (/json/*) and WebSocket on the
// same port. Rewrites ws:// URLs in HTTP responses so clients connect through
// the proxy, and intercepts browser-level CDP commands Wine/Electron doesn't
// support, returning fake success.
//
// This is a TS port of the legacy Python `cdp_proxy.py`. The WebSocket
// proxying is done with manual frame encoding because a transparent relay must
// forward binary/text frames byte-for-byte and needs to peek at text frames to
// implement interception — the high-level WebSocket APIs can't do that.

import { log } from "./logger.ts";
import { CDP_PROXY_BIND, CDP_PROXY_PORT, QUARK_CDP_PORT } from "./env.ts";

const QUARK_HOST = "127.0.0.1";

// Browser-level CDP commands not supported by Wine/Electron — return empty success.
const INTERCEPT = new Set([
  "Browser.setDownloadBehavior",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setPermission",
]);

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ── WebSocket helpers ────────────────────────────────────────────────────────

async function wsAccept(key: string): Promise<string> {
  const data = new TextEncoder().encode(key + WS_GUID);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

const MAX_FRAME = 64 * 1024 * 1024;

/** Read one WebSocket frame from a reader that has an internal byte buffer. */
export async function readFrame(
  buf: ByteBuffer,
): Promise<{ opcode: number; payload: Uint8Array } | null> {
  const hdr = await buf.read(2);
  if (!hdr) return null;
  if (hdr.length !== 2) throw new Error("truncated frame header");
  const opcode = hdr[0] & 0x0f;
  const masked = (hdr[1] & 0x80) !== 0;
  let len = hdr[1] & 0x7f;
  if (len === 126) {
    const ext = await buf.read(2);
    if (!ext) throw new Error("truncated extended length");
    len = (ext[0] << 8) | ext[1];
  } else if (len === 127) {
    const ext = await buf.read(8);
    if (!ext) throw new Error("truncated extended length");
    const hi = (ext[0] * 2 ** 24) + (ext[1] << 16) + (ext[2] << 8) + ext[3];
    const lo = (ext[4] << 24) + (ext[5] << 16) + (ext[6] << 8) + ext[7];
    len = hi * 2 ** 32 + lo;
  }
  if (len > MAX_FRAME) throw new Error("frame too large");
  const mask = masked ? (await buf.read(4)) ?? new Uint8Array(0) : null;
  const payload = await buf.read(len);
  if (payload === null || payload.length !== len) {
    throw new Error("truncated frame payload");
  }
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload };
}

/** Encode an unmasked server → client frame. */
export function frameServer(payload: Uint8Array, opcode = 1): Uint8Array {
  const out = new Uint8Array(
    headerLength(payload.length, false) + payload.length,
  );
  const head = encodeHeader(out, opcode, payload.length, false);
  out.set(payload, head.length);
  return out;
}

/** Encode a masked client → server frame (masking is required by the spec). */
export function frameClient(payload: Uint8Array, opcode = 1): Uint8Array {
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const masked = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  // headerLength(..., true) already includes the 4 mask bytes.
  const out = new Uint8Array(
    headerLength(payload.length, true) + payload.length,
  );
  const head = encodeHeader(out, opcode, payload.length, true);
  out.set(mask, head.length);
  out.set(masked, head.length + 4);
  return out;
}

function headerLength(len: number, masked: boolean): number {
  let n = 2;
  if (len >= 126 && len < 65536) n += 2;
  else if (len >= 65536) n += 8;
  if (masked) n += 4;
  return n;
}

function encodeHeader(
  out: Uint8Array,
  opcode: number,
  len: number,
  masked: boolean,
): Uint8Array {
  let p = 0;
  out[p++] = 0x80 | opcode;
  const maskBit = masked ? 0x80 : 0;
  if (len < 126) {
    out[p++] = maskBit | len;
  } else if (len < 65536) {
    out[p++] = maskBit | 126;
    out[p++] = (len >> 8) & 0xff;
    out[p++] = len & 0xff;
  } else {
    out[p++] = maskBit | 127;
    const hi = Math.floor(len / 2 ** 32);
    const lo = len >>> 0;
    out[p++] = (hi >>> 24) & 0xff;
    out[p++] = (hi >>> 16) & 0xff;
    out[p++] = (hi >>> 8) & 0xff;
    out[p++] = hi & 0xff;
    out[p++] = (lo >>> 24) & 0xff;
    out[p++] = (lo >>> 16) & 0xff;
    out[p++] = (lo >>> 8) & 0xff;
    out[p++] = lo & 0xff;
  }
  return out.subarray(0, p);
}

/** A byte buffer over a ReadableStream reader that supports arbitrary reads. */
export class ByteBuffer {
  private chunks: Uint8Array[] = [];
  private pos = 0;
  private done = false;

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async read(n: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.peek();
      if (!chunk) {
        if (this.done) return filled === 0 ? null : out.subarray(0, filled);
        await this.pull();
        continue;
      }
      const take = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      this.consume(take);
    }
    return out;
  }

  /** Remaining bytes of the front chunk, or null when no bytes are buffered. */
  private peek(): Uint8Array | null {
    if (this.chunks.length === 0) return null;
    const rest = this.chunks[0].subarray(this.pos);
    return rest.length === 0 ? null : rest;
  }

  /** Advance the buffer position past `take` bytes, dropping exhausted chunks. */
  private consume(take: number): void {
    this.pos += take;
    if (this.pos >= this.chunks[0].length) {
      this.chunks.shift();
      this.pos = 0;
    }
  }

  private async pull(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done) {
      this.done = true;
      return;
    }
    this.chunks.push(value as Uint8Array);
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/** Read the request line + headers. Returns (path, headers). */
async function readHttpHead(
  buf: ByteBuffer,
): Promise<{ path: string; headers: Record<string, string> }> {
  let raw = "";
  while (raw.length < 65536) {
    const line = await buf.read(1);
    if (!line) break;
    raw += String.fromCharCode(line[0]);
    if (raw.endsWith("\r\n\r\n")) break;
  }
  const lines = raw.split("\r\n").filter((l) => l.length > 0);
  const parts = lines[0]?.split(" ") ?? [];
  const path = parts.length >= 2 ? parts[1] : "/";
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1)
        .trim();
    }
  }
  return { path, headers };
}

async function fetchJson(
  quarkPort: number,
  path: string,
  rewriteHost: string,
): Promise<{ body: Uint8Array; contentType: string }> {
  const resp = await fetch(`http://${QUARK_HOST}:${quarkPort}${path}`, {
    headers: { Host: `${QUARK_HOST}:${quarkPort}` },
    signal: AbortSignal.timeout(5000),
  });
  const contentType = resp.headers.get("Content-Type") ?? "application/json";
  const body = new Uint8Array(await resp.arrayBuffer());
  // Rewrite the ws:// address to the client-facing host.
  const needle = new TextEncoder().encode(`ws://${QUARK_HOST}:${quarkPort}`);
  const replace = new TextEncoder().encode(`ws://${rewriteHost}`);
  return { body: replaceBytes(body, needle, replace), contentType };
}

function replaceBytes(
  src: Uint8Array,
  needle: Uint8Array,
  replace: Uint8Array,
): Uint8Array {
  if (needle.length === 0) return src;
  const chunks: Uint8Array[] = [];
  let i = 0;
  while (i <= src.length - needle.length) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (src[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      chunks.push(replace);
      i += needle.length;
    } else {
      chunks.push(src.subarray(i, i + 1));
      i++;
    }
  }
  if (i < src.length) chunks.push(src.subarray(i));
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

// ── WebSocket proxy ──────────────────────────────────────────────────────────

async function proxyWs(
  clientConn: Deno.Conn,
  clientBuf: ByteBuffer,
  quarkPort: number,
  wsPath: string,
  onActivity: () => void,
): Promise<void> {
  let quark: Deno.Conn;
  try {
    quark = await Deno.connect({ hostname: QUARK_HOST, port: quarkPort });
  } catch (e) {
    log.warn(
      `[cdp-proxy] quark not listening on :${quarkPort} — closing client: ${e}`,
    );
    clientConn.close();
    return;
  }

  // Act as a WS client toward Quark.
  const proxyKey = btoa("cdpproxy-key-1234");
  const handshake = `GET ${wsPath} HTTP/1.1\r\n` +
    `Host: ${QUARK_HOST}:${quarkPort}\r\n` +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Key: ${proxyKey}\r\n` +
    "Sec-WebSocket-Version: 13\r\n\r\n";
  const hw = quark.writable.getWriter();
  await hw.write(new TextEncoder().encode(handshake));
  hw.releaseLock();

  // Consume Quark's 101 response.
  const quarkBuf = new ByteBuffer(quark.readable.getReader());
  await readHttpHead(quarkBuf);

  const qw = quark.writable.getWriter();
  const cw = clientConn.writable.getWriter();
  let clientClosed = false;
  let quarkClosed = false;
  const closeBoth = () => {
    if (!clientClosed) {
      clientClosed = true;
      clientConn.close();
    }
    if (!quarkClosed) {
      quarkClosed = true;
      quark.close();
    }
  };

  const pump = async (
    src: ByteBuffer,
    dst: WritableStreamDefaultWriter<Uint8Array>,
    isClientSrc: boolean,
  ) => {
    const dir = isClientSrc ? "client→" : "quark→";
    try {
      while (true) {
        const frame = await readFrame(src);
        if (!frame) {
          log.info(`[cdp-proxy] ${dir}relay: source EOF — closing both`);
          break;
        }
        const { opcode, payload } = frame;
        if (opcode === 8) {
          // close
          await dst.write(
            isClientSrc ? frameClient(payload, 8) : frameServer(payload, 8),
          );
          break;
        }
        if (isClientSrc && opcode === 1) {
          // text from client — check for interception
          try {
            const msg = JSON.parse(new TextDecoder().decode(payload)) as {
              method?: string;
              id?: number;
            };
            if (msg.method && INTERCEPT.has(msg.method)) {
              // The fake success must go back to the CLIENT (cw), not toward
              // Quark (dst). Quark is never told about this command.
              const fake = JSON.stringify({ id: msg.id, result: {} });
              await cw.write(frameServer(new TextEncoder().encode(fake)));
              onActivity();
              continue;
            }
          } catch {
            // not JSON or no method — forward as-is
          }
        }
        await dst.write(
          isClientSrc
            ? frameClient(payload, opcode)
            : frameServer(payload, opcode),
        );
        if (isClientSrc) onActivity();
      }
    } catch (e) {
      // connection error — end this direction
      log.warn(`[cdp-proxy] ${dir}relay error — closing both: ${e}`);
    } finally {
      closeBoth();
    }
  };

  try {
    await Promise.all([
      pump(clientBuf, qw, true),
      pump(quarkBuf, cw, false),
    ]);
  } finally {
    closeBoth();
    qw.releaseLock();
    cw.releaseLock();
  }
}

// ── Connection handler ───────────────────────────────────────────────────────

async function handleConnection(
  conn: Deno.Conn,
  quarkPort: number,
  proxyPort: number,
  onActivity: () => void,
): Promise<void> {
  const buf = new ByteBuffer(conn.readable.getReader());
  try {
    const { path, headers } = await readHttpHead(buf);

    if (headers["upgrade"]?.toLowerCase() === "websocket") {
      const wsKey = headers["sec-websocket-key"] ?? "";
      const accept = await wsAccept(wsKey);
      const resp = "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`;
      const w = conn.writable.getWriter();
      await w.write(new TextEncoder().encode(resp));
      w.releaseLock();
      onActivity();
      await proxyWs(conn, buf, quarkPort, path, onActivity);
      return;
    }

    onActivity();
    const rewriteHost = headers["host"] ?? `127.0.0.1:${proxyPort}`;
    try {
      const { body, contentType } = await fetchJson(
        quarkPort,
        path,
        rewriteHost,
      );
      const w = conn.writable.getWriter();
      await w.write(new TextEncoder().encode(
        "HTTP/1.1 200 OK\r\n" +
          `Content-Type: ${contentType}\r\n` +
          `Content-Length: ${body.length}\r\n\r\n`,
      ));
      await w.write(body);
      w.releaseLock();
    } catch (err) {
      const msg = new TextEncoder().encode(String(err));
      const w = conn.writable.getWriter();
      await w.write(new TextEncoder().encode(
        "HTTP/1.1 502 Bad Gateway\r\n" +
          `Content-Length: ${msg.length}\r\n\r\n`,
      ));
      await w.write(msg);
      w.releaseLock();
    }
  } catch {
    // malformed request — just drop the connection
  } finally {
    conn.close();
  }
}

/** Start the CDP proxy. Returns a close function. */
export function startCdpProxy(
  opts: {
    onActivity?: () => void;
    quarkPort?: number;
    proxyPort?: number;
    bind?: string;
  } = {},
): { close: () => void; port: number } {
  const quarkPort = opts.quarkPort ?? QUARK_CDP_PORT;
  const proxyPort = opts.proxyPort ?? CDP_PROXY_PORT;
  const bind = opts.bind ?? CDP_PROXY_BIND;
  const onActivity = opts.onActivity ?? (() => {});

  const listener = Deno.listen({
    hostname: bind,
    port: proxyPort,
  });
  const actualPort = (listener.addr as Deno.NetAddr).port;

  const serve = async () => {
    for await (const conn of listener) {
      handleConnection(conn, quarkPort, proxyPort, onActivity)
        .catch((e) => log.debug(`cdp-proxy connection error: ${e}`));
    }
  };
  serve().catch((e) => log.error(`cdp-proxy serve error: ${e}`));

  log.info(`[cdp-proxy] ${bind}:${actualPort} → ${QUARK_HOST}:${quarkPort}`);
  return {
    close: () => {
      listener.close();
    },
    port: actualPort,
  };
}
