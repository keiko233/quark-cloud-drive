// Typed oRPC client for apps/server (the process manager). Built from the
// shared serverContract using the OpenAPI protocol, so it talks to the
// server's OpenAPI handler over plain HTTP.

import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { serverContract } from "@quark/contract/server";
import { SERVER_URL } from "../env.ts";

export type ServerClient = ContractRouterClient<typeof serverContract>;

export const serverClient = createORPCClient<ServerClient>(
  new OpenAPILink(serverContract, {
    url: SERVER_URL,
  }),
);
