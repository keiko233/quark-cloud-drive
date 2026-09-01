import { assertEquals } from "@std/assert";
import { isProcedure } from "@orpc/server";
import { clientRouter } from "./router.ts";
import { snake } from "./mcp.ts";

function snakeImpl(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

// The snake() used by the MCP bridge must produce the documented tool names.
Deno.test("MCP tool names: snake_case conversion", () => {
  assertEquals(snakeImpl("queueStatus"), "queue_status");
  assertEquals(snakeImpl("loginQRCode"), "login_qr_code");
  assertEquals(snakeImpl("listFile"), "list_file");
  assertEquals(snakeImpl("downloadStatus"), "download_status");
  assertEquals(snakeImpl("updateDownloadStatus"), "update_download_status");
  assertEquals(snakeImpl("importShareLink"), "import_share_link");
});

// The router must expose exactly the procedures the MCP bridge walks.
Deno.test("MCP: every business procedure opts in via contract meta", () => {
  const optedIn: string[] = [];
  const notOpted: string[] = [];
  for (const [key, value] of Object.entries(clientRouter)) {
    if (!value || typeof value !== "object") continue;
    if (!isProcedure(value)) continue;
    const def =
      (value as { "~orpc"?: { meta?: { mcp?: { tool?: boolean } } } })[
        "~orpc"
      ];
    if (def?.meta?.mcp?.tool === true) optedIn.push(key);
    else notOpted.push(key);
  }
  assertEquals(
    optedIn,
    [
      "version",
      "queueStatus",
      "loginQRCode",
      "loginStatus",
      "userInfo",
      "listFile",
      "downloadFile",
      "downloadStatus",
      "updateDownloadStatus",
      "importShareLink",
    ],
  );
  // The events SSE bus is NOT a tool.
  assertEquals(notOpted, ["events"]);
});

// The snake() export must match the standalone implementation (guards drift).
Deno.test("MCP: snake export matches helper", () => {
  for (
    const input of [
      "queueStatus",
      "loginQRCode",
      "downloadFile",
      "version",
      "updateDownloadStatus",
    ]
  ) {
    assertEquals(snake(input), snakeImpl(input));
  }
});
