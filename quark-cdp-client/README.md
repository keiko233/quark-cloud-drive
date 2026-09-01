# quark-remote-client

A Deno service that connects to a browser over CDP and exposes a small HTTP API for Quark Cloud Drive.

## Env

| Name | Default |
| --- | --- |
| `CDP_URL` | `http://127.0.0.1:9222` |
| `RECONNECT_INTERVAL_MS` | `5000` |
| `LOG_LEVEL` | `trace` |
| `SERVER_PORT` | `3000` |
| `CDP_FORWARD_HOST` | `quark-docker` |
| `CDP_FORWARD_PORT` | `9223` |
| `CDP_FORWARD_LOCAL_PORT` | `9222` |

In Docker Compose, run a local TCP forwarder inside `quark-cdp-client` so the
loopback CDP websocket returned by Chromium stays reachable from the client:

```yaml
quark-cdp-client:
  build: .
  environment:
    CDP_URL: http://127.0.0.1:${CDP_FORWARD_LOCAL_PORT:-9222}
    CDP_FORWARD_HOST: ${CDP_FORWARD_HOST:-quark-docker}
    CDP_FORWARD_PORT: ${CDP_FORWARD_PORT:-9223}
    CDP_FORWARD_LOCAL_PORT: ${CDP_FORWARD_LOCAL_PORT:-9222}
```

Note: `quark-docker` exposes CDP to peer containers on port `9223` via its
internal cdp-proxy, even though the browser itself still listens on `127.0.0.1:9222`
inside that container.

## Local

```bash
deno task dev
```

## Docker

See at `docker-compose.yaml`

## Service

OpenAPI document is available at `http://localhost:3000`.

OpenAPI spec at `http://localhost:3000/spec.json`.
