// apps/client entrypoint — orchestration + business + monitoring (see docs/refactor-design.md).
import { clientContract } from "@quark/contract/client";

const procedures = Object.keys(clientContract);
console.log(`quark-client placeholder (contract: ${procedures.join(", ")})`);
