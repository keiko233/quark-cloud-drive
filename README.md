# quark-cloud-drive

Monorepo for automating Quark Cloud Drive (夸克网盘). It runs the desktop
client inside Docker under Wine/Electron with Xorg + VNC, and drives it
headlessly over the Chrome DevTools Protocol (CDP) from a Deno service. A Deno
2 workspace with two apps and one shared contract package:

- **`apps/server`** — thin process manager + CDP proxy for the Wine/Electron
  Quark instance (Xorg + x11vnc). Exposes process lifecycle (`/start`,
  `/stop`, `/restart`), window control (`/minimize`, `/restore`), status, and a
  live `/events` SSE stream. There is **no** idle/sleep policy here — that's the
  client's job.
- **`apps/client`** — the remote client. Connects to the browser over CDP via
  Playwright, exposes a typed HTTP API **and** an MCP server, serves noVNC
  (`/vnc`) and Chrome DevTools (`/devtools`) pages, owns the idle policy, and
  persists task/download history in Deno KV.
- **`packages/contract`** — the shared oRPC contract (zod schemas) both apps
  build on, so RPC, OpenAPI, and MCP all come from one definition.

The top-level `docker-compose.yaml` runs both apps together on a shared network.

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

| Container      | What it runs                       | Host mapping                                |
| -------------- | ---------------------------------- | ------------------------------------------- |
| `quark-server` | Quark under Wine + manager + CDP   | VNC `:5900`, CDP proxy `:9223`, manager `:8080` |
| `quark-client` | Deno remote client (API/MCP/UI)    | HTTP `:3000`                                |

Notes:
- The `./wine-data-spark` volume is the default runtime data dir — the current
  installer crashes before creating a visible Electron window, so the app is
  driven from its Spark-bottle profile. Downloads land in `./downloads`.
- The client's Deno KV store survives restarts via the `client-data` volume.

### Local dev

```bash
deno task dev:server    # boot apps/server (or: deno task --cwd apps/server dev:api)
deno task dev:client    # boot apps/client with --watch
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
  (3000), `CLIENT_IDLE_MINIMIZE_AFTER_MS` / `CLIENT_IDLE_STOP_AFTER_MS` (idle
  policy), `QUEUE_*`, `CLIENT_KV_PATH`, `LOG_LEVEL`.

## API surfaces

- **Server** (`http://localhost:8080`) — plain `/healthz`; OpenAPI spec at
  `/openapi.json`; manager routes `/status`, `/start`, `/stop`, `/restart`,
  `/minimize`, `/restore`, and `/events` (SSE of process state + CDP activity).
- **Client** (`http://localhost:3000`) — OpenAPI docs at `/`, spec at
  `/spec.json`. Business endpoints: `/version`, `/queue-status`, `/events`,
  `/login-qrcode`, `/login-status`, `/user-info`, `/list-file`,
  `/download-file`, `/download-status`, `/import-share-link`. The manager
  surface is re-exposed under `/manager/*` (forwarded to the server contract).
- **MCP** — `/mcp` exposes the client contract (including `manager_*`) as MCP
  tools over Streamable HTTP.
- **noVNC** — `/vnc` page with a WebSocket→VNC proxy under `/vnc/ws`.
- **DevTools** — `/devtools` target picker; `/devtools/ws/*` bridges the
  DevTools frontend WebSocket to the CDP proxy; `/devtools/http/*` proxies the
  browser-hosted frontend assets.
- **History** — `/history` returns recent task/download records from Deno KV
  (ops convenience, not part of the contract).

## Checks

```bash
deno task check    # fmt + lint + typecheck
deno task test     # unit + contract + mcp tests (Deno KV)
```

## CI

`.github/workflows/` builds and pushes both images to GHCR on push to `main`:

- `server.yml` — builds `ghcr.io/keiko233/quark-server` (Wine prefix + runtime).
- `client.yml` — builds `ghcr.io/keiko233/quark-client`.