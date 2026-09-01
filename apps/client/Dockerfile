# apps/client — business logic / orchestration / monitoring for the headless
# Quark client. Exposes REST (oRPC OpenAPI) + MCP over Streamable HTTP.
#
# Build context must be the repository root so the workspace members
# (`@quark/contract`) resolve via ./deno.json.
FROM denoland/deno:2.2.8

# noVNC UI assets served by the client at /vnc/ (the WebSocket→VNC proxy is
# in-process Deno, so websockify/socat are not needed).
RUN apt-get update && apt-get install -y --no-install-recommends novnc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./deno.json /app/deno.json
COPY ./apps/client /app/apps/client
COPY ./packages/contract /app/packages/contract

# Pre-fetch deps at build time.
RUN deno cache /app/apps/client/src/main.ts

WORKDIR /app/apps/client

EXPOSE 3000

CMD ["deno", "run", "-A", "--unstable-kv", "src/main.ts"]