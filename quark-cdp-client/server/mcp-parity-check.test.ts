// Verifies the parity-check logic in server/mcp.ts catches drift in both
// directions. Replicates the guard exactly — if you change the check there,
// update it here too.

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function parityCheck(
  advertised: string[],
  handled: string[],
): { ok: boolean; error?: string } {
  const adv = new Set(advertised);
  const hdl = new Set(handled);
  const unhandled = [...adv].filter((n) => !hdl.has(n));
  const unadvertised = [...hdl].filter((n) => !adv.has(n));
  if (unhandled.length > 0 || unadvertised.length > 0) {
    return {
      ok: false,
      error:
        `advertised-but-unhandled=[${unhandled.join(", ")}], ` +
        `handled-but-unadvertised=[${unadvertised.join(", ")}]`,
    };
  }
  return { ok: true };
}

Deno.test("parity check passes when advertised and handled match", () => {
  const result = parityCheck(
    ["get_version", "get_queue_status", "import_share_link"],
    ["get_version", "get_queue_status", "import_share_link"],
  );
  if (!result.ok) throw new Error(result.error);
});

Deno.test("parity check fails when a tool is advertised but not handled", () => {
  // Simulates the original bug: import_share_link in TOOLS but missing from
  // MCP_TOOL_HANDLERS.
  const result = parityCheck(
    ["get_version", "get_queue_status", "import_share_link"],
    ["get_version", "get_queue_status"],
  );
  if (result.ok) throw new Error("expected drift to be detected");
  if (!result.error?.includes("import_share_link")) {
    throw new Error(`expected name in error, got: ${result.error}`);
  }
});

Deno.test("parity check fails when a handler exists but isn't advertised", () => {
  const result = parityCheck(
    ["get_version"],
    ["get_version", "ghost_tool"],
  );
  if (result.ok) throw new Error("expected drift to be detected");
  if (!result.error?.includes("ghost_tool")) {
    throw new Error(`expected name in error, got: ${result.error}`);
  }
});

// Sanity check: the real production state has matching sets.
// This imports the actual module — if parity check in mcp.ts is broken, this
// import will throw at module load and the test will fail.
Deno.test("real server/mcp.ts parity check passes on current code", async () => {
  await import("./mcp.ts");
});
