### MCP × agent loop pipeline integration test

New integration test `src/test/pipeline.mcp.integration.test.ts` drives
`handle-message` end-to-end through the production registry / pool /
dispatcher pipeline against a real Streamable-HTTP MCP echo server,
plus an llmock fixture for the Anthropic round-trip. Catches the wiring
gaps the registry-level tests (`mcp.integration.test.ts`,
`mcp-http.integration.test.ts`) cannot see:

- `resolveTools` output merges into the agent loop's tool list and
  surfaces through the LLM's tool block;
- the `mcp__<server>__<tool>` name encoding survives the round trip
  from registry → prompt → LLM tool_use → dispatcher → MCP server;
- tool results wrap back into the conversation as `tool_result` blocks
  and the LLM's follow-up text references the echoed payload.

**Echo server (`src/test/mcp-http-echo-server.ts`):** a ~80 LOC
`StreamableHTTPServerTransport`-backed Node HTTP server, stateless mode
(fresh transport + `McpServer` per POST). Booted once in
`test/integration-setup.ts`, URL provided via vitest's
`provide("mcpEchoUrl", url)` so every worker can `inject` it. The
production `HostRunner` reaches it via `StreamableHTTPClientTransport` —
no test-only runner injection (`mcpRunnerOverride`) on the bootstrap
path; the spike that introduced one is reverted.

**Why HTTP rather than `InMemoryTransport.createLinkedPair()`:** Inngest
`connect`-mode is multi-worker. When `pipeline.integration.test.ts` and
this test both bootstrap and connect in parallel, the gateway can route
an `inbound/arrived` event to either worker. An in-process linked
transport would live only on the originating worker and dispatch would
fail on the peer. The HTTP server lives in the test orchestrator
process and is reachable from any worker.

**Seeding via the registry API:** `addServer → approveServer →
approveTool` — `approveServer` connects through `HostRunner`, calls
`listTools()` against the live echo server, and pins the schema. No
duplicated tool descriptions between the test seed and the live tool;
no raw `db.insert` against `mcp_servers` / `mcp_server_tools`. The
`mcp_servers` row is cleaned up via `mcpRegistry.removeServer` in
`afterAll` so subsequent integration tests don't see a stray
`echotest` row.

**Assertion strategy — poll `messages` rather than an Inngest capture
function:** `inngest.connect` consolidates registrations under one
`app id: "cogmo"`, and a per-test capture function registered on a
unique id ends up shadowed by the peer test's capture (which lives in
the peer test's fork — this fork never sees the event). Polling the
shared Postgres for the conversation's final assistant message is
fork-routing-independent and asserts the same end-to-end behavior. The
outbound-event surface itself is already covered by
`pipeline.integration.test.ts`'s `processes inbound/arrived
end-to-end`.

**Fixture file:** `test/fixtures/recorded/anthropic-mcp-pipeline.json`
holds both Anthropic turns. Both turns carry a `userMessage` filter —
tool_result blocks land as `role: "tool"` in the OpenAI shape, so the
original user prompt survives as the latest `role: "user"` message and
aimock's `userMessage` substring filter scopes each turn to this test's
request. `anthropic-image-gen.json`'s turn-1 has also been tightened
with the same per-test `userMessage` filter, so fixture-vs-fixture
disambiguation no longer leans on filename load order — each fixture
owns its own scope.
