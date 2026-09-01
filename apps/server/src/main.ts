// apps/server entrypoint — thin process manager + CDP proxy (see docs/refactor-design.md).
import { serverContract } from "@quark/contract/server";

const procedures = Object.keys(serverContract);
console.log(`quark-server placeholder (contract: ${procedures.join(", ")})`);
