// Legacy `/manager-*` passthrough for upstream consumers that talked to the
// old FastAPI manager (quark-docker) directly. Each route is a thin forward to
// the typed serverClient (apps/server). Flat kebab names preserved for
// compatibility; intentionally NOT mirrored to MCP or the client contract.

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { serverClient } from "../server-client/index.ts";

function errorStatus(error: unknown): ContentfulStatusCode {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status <= 599) {
    return status as ContentfulStatusCode;
  }
  return 502;
}

export const managerPassthrough = new Hono();

managerPassthrough.get("/manager-status", async (c) => {
  try {
    return c.json(await serverClient.status());
  } catch (error) {
    return c.json(
      { code: "PASSTHROUGH_ERROR", message: String(error) },
      errorStatus(error),
    );
  }
});

for (
  const [path, call] of [
    ["/manager-start", () => serverClient.start()],
    ["/manager-stop", () => serverClient.stop()],
    ["/manager-restart", () => serverClient.restart()],
    ["/manager-minimize", () => serverClient.minimize()],
    ["/manager-restore", () => serverClient.restore()],
  ] as const
) {
  managerPassthrough.post(path, async (c) => {
    try {
      return c.json(await call());
    } catch (error) {
      return c.json(
        { code: "PASSTHROUGH_ERROR", message: String(error) },
        errorStatus(error),
      );
    }
  });
}
