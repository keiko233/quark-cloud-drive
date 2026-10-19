// apps/app — the single entrypoint.
//
// One process, one image: the entrypoint only composes the libraries. Process
// lifecycle and the CDP proxy come from @quark/manager, the business
// capabilities and session from @quark/drive, and the API surface plus idle
// policy from @quark/service.

import { bootstrap } from "@quark/service";

await bootstrap();
