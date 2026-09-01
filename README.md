# quark-cloud-drive

Monorepo for the Quark Cloud Drive automation stack. It merges two former
standalone projects into a single repo:

- **`quark-docker/`** — a Docker image that runs the Quark Cloud Drive desktop
  client under Wine/Electron with Xorg + VNC/noVNC, plus a Python manager
  (FastAPI) providing a REST API: process lifecycle (`/start`, `/stop`,
  `/restart`), window control (`/minimize`, `/restore`), status, and a two-stage
  idle/monitor CDP proxy (9223 → 9222).

- **`quark-cdp-client/`** — a Deno service that connects to the browser over CDP
  (the one running inside `quark-docker`) and exposes a small HTTP API for Quark
  Cloud Drive. It calls the manager's `/start` before each business request and
  re-exposes `/manager/*` passthrough routes.

The top-level `docker-compose.yaml` orchestrates both services together on a
shared network.

## Structure

```
quark-cloud-drive/
├── docker-compose.yaml        # orchestrates both services
├── .env.example               # all tunable env vars
├── quark-docker/              # Wine/Electron Quark instance + manager
│   ├── Dockerfile
│   ├── scripts/               # run/launch/cdp_proxy/manager/prepare
│   ├── download-client.ts     # fetches the official installer
│   └── ...
└── quark-cdp-client/          # Deno CDP -> HTTP API service
    ├── main.ts
    ├── server/  client/  libs/
    └── ...
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

## Env

Full list in `.env.example`. Key groups:

- Resource limits: `DOCKER_CPUS`, `DOCKER_MEMORY`.
- `quark-docker` manager + idle policy: `QUARK_*` (API port, autostart,
  minimize/stop timeouts, CPU busy threshold, restore-on-CDP).
- `quark-cdp-client`: `CDP_FORWARD_*` (local TCP forward to the CDP proxy),
  `QUARK_MANAGER_URL`, `QUARK_CDP_READY_*`, `SERVER_PORT`.

## Services

- **Manager API** (`quark-docker`): `http://localhost:8080` — OpenAPI at
  `/openapi.json`.
- **Client API** (`quark-cdp-client`): `http://localhost:3000` — OpenAPI
  document at `/`, spec at `/spec.json`.

## Sub-project docs

- `quark-docker/` — see the scripts and `Dockerfile` for build-time details.
  `scripts/prepare-wineprefix.sh` builds and archives the Wine prefix
  (`wineprefix.tar.zst`) used by the runtime image.
- `quark-cdp-client/README.md` — the CDP client service details.

## CI

`.github/workflows/` builds and pushes both images to GHCR on push to `main`:

- `quark-docker.yml` — builds `ghcr.io/<owner>/quark-docker` (requires the
  installer + Wine prefix build steps).
- `quark-cdp-client.yml` — builds `ghcr.io/<owner>/quark-cdp-client`.
