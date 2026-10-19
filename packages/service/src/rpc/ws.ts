// WebSocket bridges for the two browser-facing streams.
//
// Bun upgrades at the *server* level: a route cannot hand back an upgraded
// response the way `Deno.upgradeWebSocket` did, and the fetch handler must
// return `undefined` for a successful upgrade — something a Hono handler
// cannot express. So the bridges resolve their upstream before Hono sees the
// request, and all per-connection state lives on `ws.data`.

import { connect as netConnect, type Socket } from "node:net";
import { log } from "@quark/config";
import { devtoolsWsData } from "./devtools.ts";
import { vncWsData } from "./vnc.ts";

export interface VncData {
  kind: "vnc";
  hostname: string;
  port: number;
  tcp: Socket | null;
  closed: boolean;
}

export interface DevtoolsData {
  kind: "devtools";
  url: string;
  upstream: WebSocket | null;
  /** Frames received before the upstream socket opened. */
  pending: Array<string | Uint8Array>;
  closed: boolean;
}

export type WsData = VncData | DevtoolsData;

const textEncoder = new TextEncoder();

function toUint8(message: Uint8Array | ArrayBuffer): Uint8Array {
  if (message instanceof Uint8Array) {
    return new Uint8Array(
      message.buffer,
      message.byteOffset,
      message.byteLength,
    );
  }
  return new Uint8Array(message);
}

/** Tear down whatever the connection owns, without closing the socket itself. */
function teardown(data: WsData): void {
  if (data.closed) return;
  data.closed = true;
  if (data.kind === "vnc") {
    try {
      data.tcp?.destroy();
    } catch {
      // already closed
    }
  } else {
    try {
      data.upstream?.close();
    } catch {
      // already closed
    }
  }
}

/** Tear down and close the client side (what the old `close()` closure did). */
function closeAll(ws: Bun.ServerWebSocket<WsData>): void {
  teardown(ws.data);
  try {
    ws.close();
  } catch {
    // already closed
  }
}

/** noVNC: raw RFB over binary WS frames, bridged to the VNC TCP port. */
function openVnc(ws: Bun.ServerWebSocket<VncData>): void {
  const data = ws.data;
  const socket = netConnect({ host: data.hostname, port: data.port });

  socket.on("connect", () => {
    if (data.closed) {
      socket.destroy();
      return;
    }
    data.tcp = socket;
  });
  socket.on("data", (chunk: Uint8Array) => {
    if (data.closed) return;
    try {
      ws.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch {
      closeAll(ws);
    }
  });
  socket.on("error", (error) => {
    log.error(`vnc proxy connect failed: ${error}`);
    closeAll(ws);
  });
  socket.on("close", () => closeAll(ws));
}

/** DevTools: WS→WS relay onto the CDP proxy. */
function openDevtools(ws: Bun.ServerWebSocket<DevtoolsData>): void {
  const data = ws.data;
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(data.url);
  } catch (error) {
    log.error(`devtools upstream ws connect failed: ${error}`);
    closeAll(ws);
    return;
  }
  data.upstream = upstream;
  upstream.binaryType = "arraybuffer";
  upstream.onopen = () => {
    for (const frame of data.pending) {
      try {
        upstream.send(frame);
      } catch {
        // connection torn down while flushing
      }
    }
    data.pending.length = 0;
  };
  upstream.onmessage = (event) => {
    if (data.closed) return;
    try {
      ws.send(event.data as string | ArrayBuffer);
    } catch {
      closeAll(ws);
    }
  };
  upstream.onclose = () => closeAll(ws);
  upstream.onerror = () => closeAll(ws);
}

/** Server-level handler shared by every upgrade. */
export const websocket: Bun.WebSocketHandler<WsData> = {
  open(ws) {
    if (ws.data.kind === "vnc") openVnc(ws as Bun.ServerWebSocket<VncData>);
    else openDevtools(ws as Bun.ServerWebSocket<DevtoolsData>);
  },
  message(ws, message) {
    const data = ws.data;
    if (data.closed) return;
    if (data.kind === "vnc") {
      if (!data.tcp) return;
      data.tcp.write(
        typeof message === "string"
          ? textEncoder.encode(message)
          : toUint8(message),
      );
      return;
    }
    const frame = typeof message === "string" ? message : toUint8(message);
    const upstream = data.upstream;
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      try {
        upstream.send(frame);
      } catch {
        closeAll(ws);
      }
    } else {
      data.pending.push(frame);
    }
  },
  close(ws) {
    teardown(ws.data);
  },
};

/** Resolve the upstream for a request, or null when it is not a WS route. */
export function resolveUpgrade(req: Request): WsData | null {
  return vncWsData(req) ?? devtoolsWsData(req);
}
