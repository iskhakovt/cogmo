// Top-level `export {}` turns this file into a module so the
// `declare module "vitest"` block below augments vitest's existing
// types instead of replacing them. Without it, TypeScript reads it as
// a script and the `declare module` shadows every export from the real
// `vitest` package — `describe`/`expect`/`it`/etc. all start failing
// to resolve in any test file that pulls this d.ts into scope.
export {};

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    inngestBaseUrl: string;
    inngestEventKey: string;
    hindsightUrl: string;
    defaultUserId: string;
    llmockBaseUrl: string;
    /**
     * URL of the in-process MCP echo server (Streamable HTTP, stateless).
     * Provided by the integration setup; absent for unit/e2e setups.
     * Tests seed it into an `mcp_servers` row so the production
     * `HostRunner` reaches it via `StreamableHTTPClientTransport`.
     */
    mcpEchoUrl: string;
    /**
     * Docker container ID of the running app container. Provided by the
     * e2e setup; absent for unit/integration setups (those don't build
     * the image at all). Tests that need to invoke the bundled binary
     * for a one-shot CLI assertion can `docker exec` against this id.
     */
    appContainerId: string;
  }
}
