// Codegen for the quark-docker manager REST client.
//
// The spec is checked into ./openapi/manager.json so codegen is reproducible
// without a running manager. Refresh it with:
//   curl -s http://<manager>:8080/openapi.json > openapi/manager.json
// then re-run `deno task gen-manager-client`.
//
// Outputs to ./libs/manager-client (typed SDK + zod schemas).
import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "http://localhost:8080/openapi.json",
  output: "./libs/manager-client",
  plugins: [
    "@hey-api/client-fetch",
    {
      name: "@hey-api/sdk",
      // Runtime zod validation of responses — guards against drift between
      // a deployed manager and the spec we codegen'd against.
      validator: true,
    },
    {
      name: "zod",
      responses: true,
      requests: true,
    },
  ],
});
