// Chrome DevTools as a first-class page on the client, mirroring noVNC.
//
// The server exposes only the CDP proxy port (:9223), which forwards both
// /json/* HTTP and WebSocket to the embedded browser's remote debugging port.
// This module serves a DevTools entry page at /devtools, bridges the frontend's
// WebSocket back to the CDP proxy (in-process, like /vnc/ws), and proxies the
// browser-hosted DevTools frontend assets at /devtools/http/*.
//
// The browser-level DevTools frontend (inspector.html) carries a strict CSP
// that only allows ws://127.0.0.1:*; when served through the client the host
// differs, so we serve our own CSP-free shell at /devtools/http/inspector.html
// that loads the same frontend entrypoint and lets the ws URL be any host.

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CDP_URL } from "../env.ts";
import { log } from "../logger.ts";

const HTTP_PREFIX = "/devtools/http";
const WS_PREFIX = "/devtools/ws";

// CSP-free shell for the browser-hosted DevTools frontend. Mirrors the stock
// inspector.html minus the restrictive Content-Security-Policy; the frontend
// entrypoint reads the ws target from the ?ws= query parameter.
const INSPECTOR_SHELL = `<!DOCTYPE html>
<html lang="en">
<meta charset="utf-8">
<title>DevTools</title>
<meta name="referrer" content="no-referrer">
<script type="module" src="./entrypoints/inspector/inspector.js"></script>
<link href="./application_tokens.css" rel="stylesheet">
<link href="./design_system_tokens.css" rel="stylesheet">
<body class="undocked" id="-blink-dev-tools">
`;

// Target picker for /devtools. Self-contained (no external assets); fetches
// /devtools/api/targets and renders inspect links for each Quark page.
const PICKER_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quark DevTools</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; background: #1e1e1e; color: #ddd; }
  main { max-width: 760px; margin: 32px auto; padding: 0 16px; }
  h1 { font-size: 18px; }
  .card { background: #252526; border: 1px solid #333; border-radius: 8px; padding: 12px 16px; margin: 10px 0; }
  .card h2 { margin: 0 0 4px; font-size: 15px; }
  .card p { margin: 0 0 8px; color: #9d9d9d; word-break: break-all; }
  a.inspect { display: inline-block; padding: 6px 14px; background: #0e639c; color: #fff; border-radius: 5px; text-decoration: none; }
  a.inspect:hover { background: #1177bb; }
  .browser { border-color: #0e639c; }
  #error { color: #f48771; white-space: pre-wrap; }
</style>
</head>
<body>
<main>
  <h1>Quark DevTools</h1>
  <p>Pick a target to inspect. CDP is proxied through this client, so the
  DevTools connection shares the same origin.</p>
  <div id="browser"></div>
  <div id="targets"></div>
  <div id="error"></div>
</main>
<script>
  (async () => {
    const box = document.getElementById("targets");
    const br = document.getElementById("browser");
    const err = document.getElementById("error");
    try {
      const resp = await fetch("/devtools/api/targets");
      const data = await resp.json();
      if (data.error) throw new Error(data.error + "\\n" + (data.detail ?? ""));
      if (data.browser) {
        br.innerHTML = '<div class="card browser"><h2>Browser (all targets)</h2>' +
          '<p>Attach to the browser-level socket for the full multi-target view.</p>' +
          '<a class="inspect" href="' + data.browser + '">Open browser DevTools</a></div>';
      }
      if (!data.targets.length) {
        box.innerHTML = '<p>No page targets found.</p>';
      }
      for (const t of data.targets) {
        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = '<h2>' + (t.title || "(untitled)") + '</h2>' +
          '<p>' + (t.url || "") + '</p>' +
          '<a class="inspect" href="' + t.inspectUrl + '">Inspect</a>';
        box.appendChild(card);
      }
    } catch (e) {
      err.textContent = "Failed to list targets: " + e;
    }
  })();
</script>
</body>
</html>
`;

function resolveCdpTarget(): { hostname: string; port: number } {
  try {
    const url = new URL(CDP_URL);
    const port = url.port ? Number(url.port) : 9223;
    return { hostname: url.hostname, port };
  } catch {
    log.warn(`CDP_URL invalid (${CDP_URL}), falling back to server:9223`);
    return { hostname: "server", port: 9223 };
  }
}

export const devtoolsApp = new Hono();

// Target picker page: lists the browser's page targets (from /json/list) with
// an Inspect link each, plus a browser-level multi-target option.
devtoolsApp.get(
  "/devtools",
  (c) =>
    c.html(PICKER_PAGE, 200, { "Content-Type": "text/html; charset=utf-8" }),
);

// JSON feed for the picker: the CDP target list enriched with ready-made
// inspect URLs that route through this client's ws bridge + asset proxy.
devtoolsApp.get("/devtools/api/targets", async (c) => {
  const { hostname, port } = resolveCdpTarget();
  const host = c.req.header("host") ?? `127.0.0.1:${port}`;
  const inspectUrl = (wsUrl: string): string =>
    `/devtools/http/inspector.html?ws=${
      encodeURIComponent(
        `${host}${WS_PREFIX}${wsUrl.replace(/^ws:\/\/[^/]+/, "")}`,
      )
    }`;
  try {
    const listResp = await fetch(
      `http://${hostname}:${port}/json/list`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!listResp.ok) throw new Error(`CDP proxy responded ${listResp.status}`);
    const targets = await listResp.json() as Array<{
      id?: string;
      type?: string;
      title?: string;
      url?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const pickerTargets = targets
      .filter((t) => t.id && (t.type === "page" || t.type === "webview"))
      .map((t) => ({
        id: t.id,
        title: t.title ?? "",
        url: t.url ?? "",
        inspectUrl: t.webSocketDebuggerUrl
          ? inspectUrl(t.webSocketDebuggerUrl)
          : null,
      }));
    const version = await fetch(
      `http://${hostname}:${port}/json/version`,
      { signal: AbortSignal.timeout(5000) },
    ).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>);
    return c.json({
      browser: version.webSocketDebuggerUrl
        ? inspectUrl(version.webSocketDebuggerUrl)
        : null,
      targets: pickerTargets,
    });
  } catch (error) {
    return c.json(
      {
        error: `CDP not reachable at ${hostname}:${port} (is Quark running?)`,
        detail: String(error),
      },
      502,
    );
  }
});

// CSP-free inspector shell served locally so the frontend can attach to any
// ws host. Registered before the /devtools/http/* catch-all.
devtoolsApp.get(
  `${HTTP_PREFIX}/inspector.html`,
  (c) => c.html(INSPECTOR_SHELL),
);

// WebSocket bridge: browser <-> CDP proxy. Mirrors the /vnc/ws pattern but
// both sides are WebSockets, so this is a WS->WS relay instead of WS->TCP.
devtoolsApp.get(`${WS_PREFIX}/*`, (c) => {
  const path = c.req.path.slice(WS_PREFIX.length) || "/";
  const { hostname, port } = resolveCdpTarget();
  const upgrade = Deno.upgradeWebSocket(c.req.raw);
  const client = upgrade.socket;

  let upstream: WebSocket | null = null;
  const pending: Array<string | ArrayBuffer> = [];
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      client.close();
    } catch {
      // already closed
    }
    try {
      upstream?.close();
    } catch {
      // already closed
    }
  };

  client.onopen = () => {
    try {
      upstream = new WebSocket(`ws://${hostname}:${port}${path}`);
    } catch (error) {
      log.error(`devtools upstream ws connect failed: ${error}`);
      close();
      return;
    }
    upstream.binaryType = "arraybuffer";
    upstream.onopen = () => {
      for (const frame of pending) {
        try {
          upstream!.send(frame);
        } catch {
          // connection torn down while flushing
        }
      }
      pending.length = 0;
    };
    upstream.onmessage = (event) => {
      if (closed) return;
      const data = event.data as string | ArrayBuffer;
      try {
        client.send(data);
      } catch {
        close();
      }
    };
    upstream.onclose = close;
    upstream.onerror = close;
  };

  client.onmessage = (event) => {
    if (closed) return;
    const data = event.data as string | ArrayBuffer;
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      try {
        upstream.send(data);
      } catch {
        close();
      }
    } else {
      pending.push(data);
    }
  };

  client.onclose = close;
  client.onerror = close;

  return upgrade.response;
});

// Proxy the embedded browser's DevTools frontend assets so the shell and the
// frontend load from the client origin (same as /vnc/* serving noVNC assets).
// The browser serves the frontend under /devtools/*; the client URL carries an
// extra /http/ segment, so the forwarded path is /devtools + rest.
async function proxyDevtoolsAsset(c: Context, rest: string): Promise<Response> {
  const { hostname, port } = resolveCdpTarget();
  try {
    const resp = await fetch(
      `http://${hostname}:${port}/devtools${rest}`,
      { signal: AbortSignal.timeout(10000) },
    );
    const body = await resp.arrayBuffer();
    const headers: Record<string, string> = {};
    const contentType = resp.headers.get("content-type");
    if (contentType) headers["content-type"] = contentType;
    return c.body(body, resp.status as ContentfulStatusCode, headers);
  } catch (error) {
    return c.text(`devtools http proxy error: ${error}`, 502);
  }
}

devtoolsApp.get(`${HTTP_PREFIX}/*`, (c) => {
  const url = new URL(c.req.url);
  const rest = url.pathname.slice(HTTP_PREFIX.length);
  return proxyDevtoolsAsset(c, rest + url.search);
});

// Catch-all for any other root-relative /devtools/* asset the frontend may
// request (e.g. /devtools/bundled/...) that isn't served under /http/.
devtoolsApp.get("/devtools/*", (c) => {
  const url = new URL(c.req.url);
  const rest = url.pathname.slice("/devtools".length);
  return proxyDevtoolsAsset(c, rest + url.search);
});

log.debug(
  `DevTools page: /devtools (CDP → ${CDP_URL}, ws bridge + http proxy under /devtools)`,
);
