import { describe, expect, test } from "bun:test";
import { vncApp } from "./vnc.ts";

describe("noVNC surface", () => {
  test("serves the bundled client entry page", async () => {
    const response = await vncApp.request("/vnc/vnc_lite.html");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/html");
    expect(await response.text()).toContain('from "./core/rfb.js"');
  });

  test("serves noVNC core and vendor assets from the package", async () => {
    const core = await vncApp.request("/vnc/core/rfb.js");
    const vendor = await vncApp.request(
      "/vnc/vendor/pako/lib/zlib/inflate.js",
    );

    expect(core.status).toBe(200);
    expect(core.headers.get("content-type")).toStartWith(
      "application/javascript",
    );
    expect(await core.text()).toContain("class RFB");
    expect(vendor.status).toBe(200);
    expect(await vendor.text()).toContain("inflate");
  });

  test("rejects paths outside the noVNC asset root", async () => {
    const response = await vncApp.request("/vnc/%2e%2e/package.json");

    expect(response.status).toBe(404);
  });
});
