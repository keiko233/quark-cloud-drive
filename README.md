# quark-cloud-drive

Monorepo for the Quark Cloud Drive automation stack.

**One image, one entrypoint, one process.** The container runs the Quark Cloud
Drive desktop client under Wine/Electron with Xorg + x11vnc, and a single Deno
process owns everything else: process lifecycle, the CDP proxy, the manager API,
the business API + MCP + noVNC surface, and the idle policy. There is no
separate client container and no runtime split.

Business endpoints are Quark JSON API calls evaluated inside the logged-in
renderer; CDP is only the transport into that renderer, never a UI driver.

## Packages

Each package owns one responsibility:

| Package           | Responsibility                                                        |
| ----------------- | --------------------------------------------------------------------- |
| `@quark/contract` | oRPC contracts + zod schemas (the API definition)                     |
| `@quark/config`   | Every runtime knob: env parsing + the shared logger                   |
| `@quark/manager`  | Wine/Electron process lifecycle, CDP proxy, manager API, its client   |
| `@quark/drive`    | The logged-in session and the Quark business capabilities             |
| `@quark/service`  | Public surface (REST/OpenAPI/MCP/noVNC/DevTools), policy, composition |
| `apps/app`        | The single entrypoint + the single Docker image                       |

`@quark/manager` exposes one `ManagerApi` interface with two transports: an
in-process (embedded) one — what the image uses — and an HTTP one for host-side
development against a containerized manager.

## Structure

```
quark-cloud-drive/
├── docker-compose.yaml        # one service
├── deno.json                  # workspace + tasks (fmt/lint/check/test)
├── .env.example               # all tunable env vars
├── apps/
│   └── app/                   # the single entrypoint + Dockerfile
│       ├── Dockerfile
│       ├── scripts/           # run-quark.sh, launch-quark.sh, wine prefix prep
│       └── src/main.ts        # await bootstrap()
└── packages/
    ├── contract/src/          # oRPC contracts + zod schemas
    ├── config/src/            # env.ts + logger.ts
    ├── manager/src/           # process.ts, cdp-proxy.ts, manager-app.ts, client.ts
    ├── drive/src/             # actions/, browser/, cache/, queue/, store/
    └── service/src/           # rpc/, session/, monitor/, guard.ts, bootstrap.ts
```

## Quick start

```bash
cp .env.example .env          # optional, tweak what you need
docker compose up --build
```

Services:

| Container           | Host mapping                                                             |
| ------------------- | ------------------------------------------------------------------------ |
| `quark-cloud-drive` | API + MCP + noVNC `:3000`, Manager `:8080`, CDP `:9223`, raw VNC `:5900` |

Notes:

- The `./wine-data-spark` volume is the default runtime data dir — the current
  installer crashes before creating a visible Electron window, so the app is
  driven from its Spark-bottle profile. Downloads land in `./downloads`.
- On every Quark launch, the server normalizes the mounted wine-data settings:
  downloads are enabled at `C:\\users\\wineuser\\Downloads` and the desktop
  floating window remains disabled. Other Quark settings are preserved.
- The Deno KV store (task history + runtime settings) survives restarts via the
  `app-data` volume.
- `/manager/*` on `:3000` and the manager API on `:8080` are the same process.
  `:8080` exists for external consumers and for host-side development.

### Local dev

For daily development, run the app inside Docker and put a second instance of
the same code on the host, pointed at the container's manager. The container
owns Wine/Quark, Xorg/VNC and the CDP proxy; the host-side instance owns only
the API surface and connects over HTTP. This avoids rebuilding the (large) app
image when iterating on API code.

```bash
docker compose up -d --build
QUARK_MANAGER_MODE=http deno task dev    # host-side service with --watch
```

Stop the container's own service port first, or set `SERVER_PORT=3001` — the
host instance binds `:3000` by default. The host-side defaults match the Compose
port mappings:

- `QUARK_MANAGER_URL=http://127.0.0.1:8080` — container manager API
- `CDP_URL=http://127.0.0.1:9223` — container CDP proxy

Copy `.env.example` to `.env` to set those once. A host-side instance has no
Wine runtime, so it cannot boot Quark itself: it drives the container's manager.

To inspect the live renderer, open `http://127.0.0.1:3000/devtools` and select
the Quark target. The CDP target list is also available at
`http://127.0.0.1:3000/devtools/api/targets`.

Without a Wine/Quark launch script present, `QUARK_AUTOSTART` is skipped with a
warning and the manager + CDP proxy still come up.

## Env

Full list in `.env.example`; every default lives in
`packages/config/src/env.ts`:

- Common: `DOCKER_CPUS`, `DOCKER_MEMORY`.
- Manager runtime: `QUARK_RUNTIME` (`spark`), `QUARK_API_PORT` (8080),
  `QUARK_CDP_PORT` (9222), `CDP_PROXY_PORT` (9223), `QUARK_AUTOSTART`,
  `LAUNCH_SCRIPT`, `WINE_*`.
- Wiring: `QUARK_MANAGER_MODE` (`embedded` | `http`), `QUARK_MANAGER_URL`,
  `SERVER_PORT` (3000), `CDP_URL`, `VNC_URL`.
- Policy/queue: `CLIENT_IDLE_*` (first-run monitor defaults), `QUEUE_*`. After
  first boot, `/config` in Deno KV is authoritative and can be changed without
  restarting.
- Persistence/logging: `QUARK_KV_PATH`, `LOG_LEVEL`.

## API surfaces

- **Manager** (`http://localhost:8080`, same process) — plain `/healthz`;
  OpenAPI spec at `/spec.json`; manager routes `/status`, `/start`, `/stop`,
  `/restart`, `/minimize`, `/restore`, and `/events` (SSE of process state + CDP
  activity).
- **App** (`http://localhost:3000`) — OpenAPI docs at `/`, spec at `/spec.json`.
  Runtime endpoints are `GET/PATCH /config` and `GET /status`. `/status` reports
  process state, login state, active cloud-task count, queue pressure, a 0–100
  readiness score, monitor timing/decision, and guard state. Business endpoints:
  `/version`, `/queue-status`, `/events`, `/login-qrcode`, `/login-status`,
  `/user-info`, `/list-file`, `/file-info`, `/download-file`, `/download-task`,
  `/task-list`, `/import-share-link`. The manager surface is re-exposed under
  `/manager/*` (forwarded to the server contract).
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
After starting the stack locally, run it explicitly:

```bash
deno task test:e2e
```

The test verifies plain JSON responses for the root and a direct `fid` lookup,
`file-info`, the cloud `task-list`, that the old `path` query now returns HTTP
400, and that the visible page route does not change. A second opt-in test
(`download.e2e.test.ts`) downloads the smallest file in the account, waits for
the task to report `finish`, checks the artifact in the app's Downloads folder
(host mount `<repo>/downloads`, override with `QUARK_DOWNLOADS_HOST_DIR`), then
cancels the task and removes the file. CI can keep using the default unit tests
without a Quark/Wine login; if CI later provides a login session, set
`QUARK_E2E=1`, `QUARK_API_URL`, and `CDP_URL` to run the same tests.

## CI

`.github/workflows/app.yml` builds and pushes the single image to GHCR on push
to `main`:

- `ghcr.io/keiko233/quark-cloud-drive` — Wine prefix + Quark + the Deno app.

It replaces the former `quark-server` and `quark-client` images, which are no
longer built.
