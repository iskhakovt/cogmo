### MCP × agent loop pipeline integration test

New integration test `src/test/pipeline.mcp.integration.test.ts` drives
`handle-message` end-to-end with a real MCP server reached through the
production registry / pool / dispatcher pipeline, plus an llmock
fixture for the Anthropic round-trip. Catches the wiring gaps the
registry-level tests (`mcp.integration.test.ts`,
`mcp-http.integration.test.ts`) cannot see:

- `resolveTools` output merges into the agent loop's tool list and
  surfaces through the LLM's tool block;
- the `mcp__<server>__<tool>` name encoding survives the round trip
  from registry → prompt → LLM tool_use → dispatcher → MCP server;
- tool results wrap back into the conversation as `tool_result` blocks
  and the LLM's follow-up text references the echoed payload.

**MCP server chosen: inline + `InMemoryTransport`** (~30 LOC test
helper in `src/test/mcp-inline-server.ts`), not `server-everything`.
Researched the field's convention: the typescript-sdk's own tests use
`InMemoryTransport.createLinkedPair()`, LangChain MCP adapter +
OpenAI Agents SDK + FastMCP all use in-test servers for the same
scenario. `server-everything`'s tool list has materially drifted twice
in the last six months (Dec 2025 per-tool refactor, Jan 2026 SEP-1686
tasks added, May 2026 zod v4 / SDK 1.29) — any drift forces a
record/replay refresh because the LLM sees the tool description
verbatim. The inline server pins the test's tool schema inside the
test file, so re-record triggers come only from deliberate test
edits, not from upstream npm bumps. No subprocess + no readiness
probe is a bonus: the test runs in ~4s replay (was 6-15s with a
subprocess-based design).

**Wiring:** new `BootstrapOptions.mcpRunnerOverride` threads a custom
`Runner` into `bootstrapRuntime`'s `McpRegistryImpl` construction so
the test can replace the production `HostRunner` with one that
returns a connection backed by the linked in-memory pair. Production
wiring leaves the field undefined → `new HostRunner()` as before.

**Fixture file:** `test/fixtures/recorded/anthropic-aa-mcp-pipeline.json`
holds both Anthropic turns. The `aa-` prefix forces alphabetic load
order ahead of `anthropic-image-gen.json`, whose turn-1 fixture
matches generically on `{turnIndex: 1, hasToolResult: true}` and would
otherwise win against this test's tool_result turn. The fixture's
turn-1 entry adds `toolName: "mcp__echotest__echo"` so it cannot
spuriously match other tests that happen to take a tool_result path
but don't register the inline echo tool.
