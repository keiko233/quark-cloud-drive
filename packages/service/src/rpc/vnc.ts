// noVNC as a first-class page on the client.
//
// The server exposes only the raw VNC port (x11vnc :5900). This module serves
// the noVNC UI at /vnc/* and proxies the browser's WebSocket back to the VNC
// server with an in-process WebSocket→TCP bridge, so no separate
// websockify/socat sidecar (or distro package) is needed: the client ships as
// the `@novnc/novnc` dependency and is resolved from node_modules.
//
// Page entry: /vnc/vnc_lite.html?path=vnc/ws  (same origin as the WS proxy).

import { Hono } from "hono";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { NOVNC_STATIC_DIR, VNC_URL } from "@quark/config";
import { log } from "@quark/config";
import type { VncData } from "./ws.ts";

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

/**
 * Minimal noVNC client shell. The npm package ships `core/` and `vendor/` but
 * no HTML entry point (upstream only keeps that page in its source tree), so
 * this is the equivalent of upstream's `vnc_lite.html`: a full-window canvas
 * wired to `<same origin>/<path>`.
 */
const LITE_PAGE = `<!DOCTYPE html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quark VNC</title>
<style>
  html, body { margin: 0; height: 100%; background: #111; overflow: hidden; }
  #screen { display: block; width: 100vw; height: 100vh; }
  #status { position: fixed; top: 8px; left: 8px; padding: 4px 8px;
            font: 12px/1.5 monospace; color: #ddd; background: rgba(0,0,0,.6);
            border-radius: 4px; }
  #reconnect { display: none; position: fixed; top: 8px; right: 8px;
               font: 12px monospace; padding: 6px 10px; cursor: pointer; }
</style>
<canvas id="screen"></canvas>
<div id="status">connecting…</div>
<button id="reconnect">reconnect</button>
<script type="module">
  import RFB from "./core/rfb.js";

  const status = document.getElementById("status");
  const button = document.getElementById("reconnect");
  const params = new URLSearchParams(location.search);
  const path = (params.get("path") || "vnc/ws").replace(/^\\/+/, "");
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = scheme + "://" + location.host + "/" + path;

  let rfb = null;

  function connect() {
    button.style.display = "none";
    status.textContent = "connecting…";
    rfb = new RFB(document.getElementById("screen"), url, { shared: true });
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfb.addEventListener("connect", () => { status.textContent = "connected"; });
    rfb.addEventListener("disconnect", (event) => {
      status.textContent = "disconnected" +
        (event.detail && event.detail.clean === false ? " (error)" : "");
      button.style.display = "block";
    });
  }

  button.addEventListener("click", connect);
  // Ctrl/Cmd+V pastes the local clipboard into the remote session.
  window.addEventListener("paste", (event) => {
    const text = event.clipboardData && event.clipboardData.getData("text");
    if (text && rfb) rfb.clipboardPasteFrom(text);
  });

  connect();
</script>
</html>
`;

type NoVncRoot = { dir: string; bundled: boolean };

let assetRoot: NoVncRoot | null | undefined;

/**
 * Where noVNC's JS lives. The npm package resolves to its `core/rfb.js` entry,
 * so its root is two levels up. `NOVNC_STATIC_DIR` stays as an escape hatch
 * (a distro package or a custom build) and wins when it exists.
 */
function noVncRoot(): NoVncRoot | null {
  if (assetRoot !== undefined) return assetRoot;
  if (NOVNC_STATIC_DIR) {
    if (existsSync(NOVNC_STATIC_DIR)) {
      assetRoot = { dir: resolve(NOVNC_STATIC_DIR), bundled: false };
      return assetRoot;
    }
    log.warn(
      `NOVNC_STATIC_DIR "${NOVNC_STATIC_DIR}" does not exist — using the bundled noVNC package`,
    );
  }
  try {
    const entry = Bun.resolveSync("@novnc/novnc", import.meta.dir);
    assetRoot = { dir: dirname(dirname(entry)), bundled: true };
  } catch (error) {
    log.error(`cannot resolve the bundled noVNC package: ${error}`);
    assetRoot = null;
  }
  return assetRoot;
}

/** Resolve a request path inside the asset root, rejecting traversal. */
function assetPath(root: string, rel: string): string | null {
  const filePath = resolve(root, rel);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return filePath.startsWith(prefix) ? filePath : null;
}

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

/**
 * WebSocket → TCP bridge for noVNC (raw RFB over binary WS frames).
 *
 * Resolved before Hono: a successful Bun upgrade must leave the fetch handler
 * returning `undefined`, and it also keeps /vnc/ws ahead of the /vnc/* static
 * catch-all without relying on route order.
 */
export function vncWsData(req: Request): VncData | null {
  if (new URL(req.url).pathname !== "/vnc/ws") return null;
  const { hostname, port } = resolveVncTarget();
  return { kind: "vnc", hostname, port, tcp: null, closed: false };
}

// Static noVNC assets: the bundled package, or NOVNC_STATIC_DIR when set.
vncApp.get("/vnc/*", async (c) => {
  const rel = c.req.path.slice("/vnc/".length);
  const normalized = rel.replace(/^\/+/, "");
  const root = noVncRoot();
  if (!root) return c.text("noVNC assets unavailable", 503);
  if (
    root.bundled &&
    (normalized === "" || normalized === "index.html" ||
      normalized === "vnc_lite.html")
  ) {
    return c.html(LITE_PAGE);
  }
  const filePath = assetPath(root.dir, normalized);
  if (!filePath) return c.text("not found", 404);
  try {
    const data = new Uint8Array(await readFile(filePath));
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    return c.body(data, 200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
    });
  } catch {
    return c.text("not found", 404);
  }
});

log.debug(
  `noVNC page: /vnc (VNC → ${VNC_URL}, assets: ${
    NOVNC_STATIC_DIR || "bundled @novnc/novnc"
  })`,
);
