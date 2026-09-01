// noVNC as a first-class page on the client.
//
// The server exposes only the raw VNC port (x11vnc :5900). This module serves
// the noVNC UI (apt package under /usr/share/novnc) at /vnc/* and proxies the
// browser's WebSocket back to the VNC server with an in-process
// WebSocket→TCP bridge, so no separate websockify/socat sidecar is needed.
//
// Page entry: /vnc/vnc_lite.html?path=vnc/ws  (same origin as the WS proxy).

import { Hono } from "hono";
import { NOVNC_STATIC_DIR, VNC_URL } from "../env.ts";
import { log } from "../logger.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function resolveVncTarget(): { hostname: string; port: number } {
  try {
    const url = new URL(VNC_URL);
    const port = url.port ? Number(url.port) : 5900;
    return { hostname: url.hostname, port };
  } catch {
    log.warn(`VNC_URL invalid (${VNC_URL}), falling back to server:5900`);
    return { hostname: "server", port: 5900 };
  }
}

export const vncApp = new Hono();

// Entry page redirect: /vnc -> the lite client wired to our WS proxy.
vncApp.get("/vnc", (c) => c.redirect("/vnc/vnc_lite.html?path=vnc/ws"));

// WebSocket → TCP bridge for noVNC (raw RFB over binary WS frames).
// Registered before the static /vnc/* catch-all so it takes precedence.
vncApp.get("/vnc/ws", (c) => {
  const { hostname, port } = resolveVncTarget();
  const upgrade = Deno.upgradeWebSocket(c.req.raw);
  const ws = upgrade.socket;

  let tcp: Deno.TcpConn | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      tcp?.close();
    } catch {
      // already closed
    }
    try {
      ws.close();
    } catch {
      // already closed
    }
  };

  ws.onopen = () => {
    Deno.connect({ hostname, port })
      .then((conn) => {
        if (closed) {
          conn.close();
          return;
        }
        tcp = conn;
        (async () => {
          try {
            for await (const chunk of conn.readable) {
              if (closed) break;
              ws.send(chunk);
            }
          } catch {
            // VNC closed
          }
          close();
        })();
      })
      .catch((error) => {
        log.error(`vnc proxy connect failed: ${error}`);
        close();
      });
  };

  ws.onmessage = (event) => {
    const data = event.data;
    if (typeof data === "string") {
      tcp?.write(new TextEncoder().encode(data));
    } else if (data instanceof ArrayBuffer) {
      tcp?.write(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      tcp?.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  };

  ws.onclose = close;
  ws.onerror = close;

  return upgrade.response;
});

// Static noVNC assets (/usr/share/novnc in the container image).
vncApp.get("/vnc/*", async (c) => {
  const rel = c.req.path.slice("/vnc/".length);
  const normalized = rel.replace(/\.\./g, "").replace(/^\/+/, "");
  const filePath = `${NOVNC_STATIC_DIR}/${normalized}`;
  try {
    const data = await Deno.readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    return c.body(data, 200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
    });
  } catch {
    return c.text("not found", 404);
  }
});

log.debug(`noVNC page: /vnc (VNC → ${VNC_URL}, static: ${NOVNC_STATIC_DIR})`);
