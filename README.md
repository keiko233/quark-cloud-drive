# quark-cloud-drive

Monorepo for the Quark Cloud Drive automation stack. It merges two former
standalone projects into a single repo:

- **`quark-docker/`** — a Docker image that runs the Quark Cloud Drive desktop
  client under Wine/Electron with Xorg + VNC/noVNC, plus a Python manager
  (FastAPI) providing a REST API: process lifecycle (`/start`, `/stop`,
  `/restart`), window control (`/minimize`, `/restore`), status, and a two-stage
  idle/monitor CDP proxy (9223 → 9222).

- **`quark-cdp-client/`** — a Deno service that attaches to the browser over CDP
  (the one running inside `quark-docker`) and exposes a small HTTP API for Quark
  Cloud Drive. Business endpoints are Quark JSON API calls evaluated inside the
  logged-in renderer (no DOM automation); CDP is only the transport into that
  renderer. It calls the manager's `/start` before each business request and
  re-exposes `/manager/*` passthrough routes.

The top-level `docker-compose.yaml` orchestrates both services together on a
shared network.

## Structure

```
quark-cloud-drive/
├── docker-compose.yaml        # server + client, shared network
├── deno.json                  # workspace + tasks (fmt/lint/check/test)
├── .env.example               # all tunable env vars
├── apps/
│   ├── server/                # process manager + CDP proxy
│   │   ├── Dockerfile
│   │   ├── scripts/           # launch-quark.sh, wine prefix prep
│   │   └── src/               # process.ts, cdp-proxy.ts, main.ts
│   └── client/                # remote client
│       ├── Dockerfile
│       └── src/
│           ├── rpc/           # router, mcp, vnc, devtools
│           ├── browser/       # Playwright CDP driver
│           ├── monitor/       # idle policy (minimize -> stop)
│           ├── queue/         # operation queue
│           └── store/         # Deno KV task/download history
└── packages/contract/src/     # shared oRPC contracts + zod schemas
```

## Quick start

```bash
cp .env.example .env          # optional, tweak what you need
docker compose up --build
```

Services:

| Container          | What it runs                   | Host mapping                                                                       |
| ------------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| `quark-docker`     | Quark under Wine + manager API | VNC `:5900`, noVNC `:6080`, Manager `:8080`, CDP `:9223` (`REMOTE_DEBUGGING_PORT`) |
| `quark-cdp-client` | Deno CDP -> HTTP API           | HTTP `:3000`                                                                       |

Notes:

- The `./wine-data-spark` volume is the default runtime data dir — the current
  installer crashes before creating a visible Electron window, so the app is
  driven from its Spark-bottle profile. Downloads land in `./downloads`.
- On every Quark launch, the server normalizes the mounted wine-data settings:
  downloads are enabled at `C:\\users\\wineuser\\Downloads` and the desktop
  floating window remains disabled. Other Quark settings are preserved.
- The client's Deno KV store survives restarts via the `client-data` volume.

### Local dev

For daily development, use a Docker server with a host-side client:
`apps/server` runs Quark/Wine, Xorg/VNC, and the CDP proxy inside Docker, while
`apps/client` runs the Deno development server on the host and connects to the
Docker-published manager/CDP ports. This avoids rebuilding the client image when
iterating on Playwright operations.

```bash
docker compose up -d --build server
deno task dev:client    # boot apps/client on the host with --watch
```

The host-side client defaults match the Compose port mappings:

- `SERVER_URL=http://127.0.0.1:8080` — Docker server manager API
- `CDP_URL=http://127.0.0.1:9223` — Docker server CDP proxy

You can also copy `.env.example` to `.env` and then run `deno task dev:client`.
Use `deno task dev:server` only when working on the server manager itself; that
mode does not include the Quark/Wine runtime and cannot validate real Playwright
page operations.

To debug Playwright page operations, open the host-side client's
`http://127.0.0.1:3000/devtools` and select the relevant Quark target to inspect
the live DOM, console, and network requests. The CDP target list is also
available at `http://127.0.0.1:3000/devtools/api/targets`. Use the observed page
structure as the source of truth before changing selectors.

The full Compose stack, including the containerized client, remains available:

```bash
docker compose up --build
```

Without a Wine/Quark launch script present, `QUARK_AUTOSTART` is skipped with a
warning and the manager + CDP proxy still come up.

## Env

Full list in `.env.example`. Key groups (defaults baked into each app's
`env.ts`):

- Common: `DOCKER_CPUS`, `DOCKER_MEMORY`.
- Server (`apps/server`): `QUARK_API_PORT` (8080), `QUARK_CDP_PORT` (9222),
  `CDP_PROXY_PORT` (9223), `QUARK_AUTOSTART`, `LAUNCH_SCRIPT`, `WINE_*`.
- Client (`apps/client`): `SERVER_URL`, `CDP_URL`, `VNC_URL`, `SERVER_PORT`
  (3000), `CLIENT_IDLE_*` (first-run monitor defaults), `QUEUE_*`,
  `CLIENT_KV_PATH`, `LOG_LEVEL`. After first boot, `/config` in Deno KV is
  authoritative and can be changed without restarting the client. For host-side
  client development, use `SERVER_URL=http://127.0.0.1:8080` and
  `CDP_URL=http://127.0.0.1:9223`.

## API surfaces

- **Server** (`http://localhost:8080`) — plain `/healthz`; OpenAPI spec at
  `/openapi.json`; manager routes `/status`, `/start`, `/stop`, `/restart`,
  `/minimize`, `/restore`, and `/events` (SSE of process state + CDP activity).
- **Client** (`http://localhost:3000`) — OpenAPI docs at `/`, spec at
  `/spec.json`. Runtime endpoints are `GET/PATCH /config` and `GET /status`.
  `/status` reports process state, login state, active cloud-task count, queue
  pressure, a 0–100 readiness score, monitor timing/decision, and guard state.
  Business endpoints: `/version`, `/queue-status`, `/events`, `/login-qrcode`,
  `/login-status`, `/user-info`, `/list-file`, `/file-info`, `/download-file`,
  `/download-task`, `/task-list`, `/import-share-link`. The manager surface is
  re-exposed under `/manager/*` (forwarded to the server contract).
- **Business endpoints never drive the Quark UI.** Each one is a direct call to
  Quark's cloud-drive JSON API issued as a same-origin `fetch` inside the
  logged-in renderer, so the session cookie is applied by the browser and never
  leaves it. No endpoint queries a DOM node, clicks a row, scrolls a virtual
  list, or opens the transport tab. `/login-qrcode` is the single exception: the
  QR code is rendered client-side and has no JSON API.
- Every business endpoint accepts `raw=true` (`raw: true` in POST bodies) to
  include the untouched upstream fields under a `raw` object; normalized fields
  stay stable when Quark changes its payload. The QR code endpoint remains a
  binary PNG and does not use this wrapper.
- Locators are always Quark `fid`s (`fid=0` is the drive root). There are no
  path strings and no UI-order assumptions: `/list-file?fid=`,
  `/file-info?fid=`, `/download-file?fid=`.
- `/list-file` reads `/file/sort`; `/file-info` reads `/file/info`; `/task-list`
  reads `/task/current/list` + `/task/count` and `POST /task-list` applies
  `resume`/`delete` through `/task/status`.
- `/download-file` resolves signed URLs (short-lived — treat them as secrets). A
  file is one `/file/download` call. Quark has no folder archive, so a folder is
  scanned through `/download/list` and returns its flattened file list, each
  file with its own URL; `limit` bounds how many URLs are resolved.
- `POST /download-file` (same path, different verb) is the one endpoint with a
  disk side effect: it hands `fid` to the app's own downloader, which writes
  into the app's Downloads folder (or the `toDir` you pass) and keeps a
  resumable `.qkdownloading` partial until it finishes. Nothing is clicked; the
  store action is called directly. Signed URLs alone are not enough here,
  because plain HTTP clients are rejected by Quark's CDN (`412`) while the app's
  own network stack is accepted.
- `/download-task` is the local queue behind that endpoint: `GET` reports each
  transfer's `status` (`-1 error` … `6 finish`), progress, speed and
  destination, and `POST` applies `pause` / `resume` / `cancel` to a list of
  `taskIds`. `cancel` also deletes the leftover `.qkdownloading` partials and
  returns their paths. This is the app's engine, distinct from the cloud
  `/task-list`.
- **MCP** — `/mcp` exposes the client contract (including `manager_*`) as MCP
  tools over Streamable HTTP.
- **noVNC** — `/vnc` page with a WebSocket→VNC proxy under `/vnc/ws`.
- **DevTools** — `/devtools` target picker; `/devtools/ws/*` bridges the
  DevTools frontend WebSocket to the CDP proxy; `/devtools/http/*` proxies the
  browser-hosted frontend assets.
- **History** — `/history` returns recent task/download records from Deno KV
  (ops convenience, not part of the contract).

### Runtime policy

The monitor performs a cheap process probe and login-renderer probe at
`checkIntervalMs`. It never opens the transport UI; the active cloud-task count
(todo + running) is refreshed through the task API at `taskProbeIntervalMs` and
cached in the status snapshot. The default task probe interval is 5 minutes and
the default total idle stop threshold is 15 minutes. `minimizeAfterMs` and
`stopAfterMs` retain the two-stage idle policy (`0` disables a stage).
`stopWhenLoggedOut` optionally stops Quark as soon as
`renderer/login-window.html` is present. Protected business operations are
denied while Quark is `starting`/stopped or when their name is in
`requireLoginFor`; start, login status, and QR-code operations remain available.

## Checks

```bash
deno task check    # fmt + lint + typecheck
deno task test     # unit + contract + mcp tests (Deno KV)
```

The `list-file` API integration test requires a real Quark page and an active
login, so it is skipped by default and does not run in CI's `deno task test`.
After starting the Docker server and host-side client locally, run it
explicitly:

```bash
deno task test:e2e:client
```

The test verifies plain JSON responses for the root and a direct `fid` lookup,
`file-info`, the cloud `task-list`, that the old `path` query now returns HTTP
400, and that the visible page route does not change. A second opt-in test
(`download.e2e.test.ts`) downloads the smallest file in the account, waits for
the task to report `finish`, checks the artifact in the app's Downloads folder
(host mount `<repo>/downloads`, override with `QUARK_DOWNLOADS_HOST_DIR`), then
cancels the task and removes the file. CI can keep using the default unit tests
without a Quark/Wine login; if CI later provides a login session, set
`QUARK_E2E=1`, `CLIENT_URL`, and `CDP_URL` to run the same tests.

## CI

`.github/workflows/` builds and pushes both images to GHCR on push to `main`:

- `server.yml` — builds `ghcr.io/keiko233/quark-server` (Wine prefix + runtime).
- `client.yml` — builds `ghcr.io/keiko233/quark-client`.
