### MCP client Phase C — Streamable HTTP transport

The `transport: "http"` branch in `createTransport` now returns a real
`StreamableHTTPClientTransport` instead of throwing a "deferred to Phase C"
error. Configured remote MCP servers (e.g. Linear, Notion, Atlassian Rovo)
can be added through `/mcp add` and exercised end-to-end:

- Header values follow the existing `McpValueSource` shape — `kind: "literal"`
  for static values, `kind: "secret"` for references resolved from the
  encrypted secrets store at transport construction. Resolved headers are
  passed via `requestInit.headers`; the SDK merges them with `accept`,
  `content-type`, and `mcp-session-id` on every request.
- SDK defaults are kept — `initialReconnectionDelay: 1000`,
  `maxReconnectionDelay: 30_000`, `reconnectionDelayGrowFactor: 1.5`,
  `maxRetries: 2`, server-allocated session id. No custom `fetch` or
  `authProvider`; bearer tokens go through plain `Authorization` headers.
- `SdkMcpConnection.close()` now calls `transport.terminateSession()`
  before the SDK `close()` when the transport is streamable-HTTP, so
  per-session server-side state (Linear, Notion, Atlassian all key state
  by `Mcp-Session-Id`) is released cleanly rather than lingering until
  server-side expiry. The call is best-effort: server-may-be-gone or
  server-returns-405 errors are logged at debug and the close path
  continues.
- The deprecated split GET/POST SSE transport (`transport: "sse"`) is
  explicitly rejected at the transport factory with a guidance message
  pointing at the http variant. Streamable HTTP replaced SSE in spec
  revision `2025-03-26`; modern remote servers all expose it.

Validated by a new integration test (`src/mcp/mcp-http.integration.test.ts`)
that spawns `@modelcontextprotocol/server-everything` in `streamableHttp`
mode on a randomly-allocated port, drives the full pipeline through
`McpRegistryImpl` against the live `/mcp` endpoint, and round-trips the
`echo` tool. Phase C marker upgraded to `[confirmed]` in
[design/integrations/mcp.md](../design/integrations/mcp.md).
