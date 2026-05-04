# MCP Integration `[proposed]`

Model Context Protocol client layer. Lets users add third-party MCP servers (GitHub, Gmail, Calendar, Linear, Slack, etc.) declaratively, exposes their tools through the existing `ToolRegistry` contract, scopes them per-profile, survives server crashes, and treats every server as untrusted by default.

Replaces the prior inline `[proposed]` MCP section in [integrations.md](../integrations.md).

## Status

| Phase | Scope | Marker |
|-|-|-|
| A — core | stdio transport, host runner, schema pinning, profile globs, budget, secrets injection, `/mcp` admin commands | `[proposed]` |
| B — security | sysbox runner for `untrusted`, egress allowlist | `[proposed]` |
| C — remote | HTTP transport, manual-token auth | `[proposed]` |
| D — auth | OAuth 2.1 + DCR + refresh persistence | `[research]` |
| E — eval | Resources / prompts | `[research]` |

## Goals & non-goals

**Goals.** Long-lived MCP client layer, declarative server config in DB, per-profile glob filtering, hard tool budget, schema pinning against rug-pull, sandboxed execution for untrusted servers, secrets via the encrypted secrets table, no MCP-shape leakage above the `McpRegistry` facade.

**Non-goals (deferred, justified).**
- **Resources & prompts primitives.** ~80% of real servers ship tools-only ([digitalapplied.com 2026 stats](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol)). Stub the SDK handlers; surface nothing to the agent until a concrete use case appears.
- **OAuth Dynamic Client Registration.** Manual token entry in v1; OAuth in Phase D.
- **Hindsight via MCP.** Hindsight stays on its native HTTP client (`MemoryProvider`). See [Hindsight: native client, not MCP](#hindsight-native-client-not-mcp).
- **Public plugin marketplace / deep-link install.** Out of scope until UX exists.
- **WASM tool execution.** Tracked separately under [integrations.md → Plugin Extensibility](../integrations.md#plugin-extensibility-research).

## Architecture

### Module layout

New module: `src/mcp/`. Owns its store, client pool, ToolSpec adapter. The orchestrator imports a single facade.

```
src/mcp/
  store/
    schema.ts            # mcp_servers, mcp_server_tools tables
    index.ts             # McpStore interface + Drizzle impl
  client/
    transport.ts         # transport factory (stdio | http | sse)
    client.ts            # thin wrapper over @modelcontextprotocol/sdk Client
    pool.ts              # process-scoped connection pool, idle eviction, reconnect
    runner.ts            # subprocess runner — host or sysbox
  registry.ts            # McpRegistry: facade consumed by handle-message
  adapter.ts             # McpToolAdapter: ToolSpec → MCP callTool
  approval.ts            # tool-schema hash pinning, approval state machine
  config.ts              # zod schemas for server config + glob matchers
  index.ts               # exports
```

**Boundary rule.** `src/agent/` depends on `McpRegistry` (interface), never on `@modelcontextprotocol/sdk` directly. Same pattern as `MemoryProvider` and `LlmProvider`.

### Where it slots in

| Cogmo surface | MCP integration |
|-|-|
| `ToolRegistry` ([src/agent/tools.ts](../../src/agent/tools.ts)) | Stays static, in-process tools only. MCP tools are merged at request time. |
| Agent loop tool list ([src/agent/loop.ts](../../src/agent/loop.ts)) | `tools = [...registry.snapshot(), ...mcpTools]` once per turn. |
| `Service` ([src/agent/service.ts](../../src/agent/service.ts)) | MCP handlers receive the same scoped `Service`. ACL boundary unchanged. |
| `profiles.toolSet` ([src/agent/store/schema.ts](../../src/agent/store/schema.ts)) | Extended to support globs (`mcp__github__*`). Backwards compatible. |
| `secrets` ([src/secrets/store/schema.ts](../../src/secrets/store/schema.ts)) | Per-server credentials stored as rows; resolved at spawn / request. |
| Sandbox ([sandbox.md](../sandbox.md)) | Reused for untrusted stdio servers. No new runtime. |
| LLM tool format ([src/llm/types.ts](../../src/llm/types.ts)) | JSON Schema is already the lingua franca. MCP tool schemas pass through unchanged. |
| Inngest durability | MCP tool calls set `durable: true`, wrapped in `step.run()` for retry safety. |

## Data model

Two new tables. Designs are intent — refine as Phase A reveals issues.

### mcp_servers `[confirmed]`

```ts
// config validated via McpServerConfigSchema (Zod, discriminated union over `transport`)
{
  id: pk(),                                  // UUID v7
  createdAt: ts(),
  name: text("name").notNull().unique(),     // used in mcp__<name>__<tool>; /^[a-z][a-z0-9_]*$/
  config: jsonbZod("config", McpServerConfigSchema).notNull(),
  //   { transport: "stdio", command, args, env: { [k]: McpValueSource } }
  //   { transport: "http",  url,    headers: { [k]: McpValueSource } }
  //   { transport: "sse",   url,    headers: { [k]: McpValueSource } }
  enabled: boolean("enabled").notNull(),
  approvalStatus: pgEnum("pending" | "approved" | "needs_reapproval").notNull(),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
  lastError: text("last_error"),
}
```

Transport is **not** a separate column — the discriminator lives inside the JSONB blob. One source of truth; no risk of column/JSONB drift. If transport-keyed indexing becomes useful later, add the column with a CHECK that mirrors the JSONB.

Trust is also **not** a column. See [Trust model](#trust-model) — it's a code-level allowlist.

`name` uniqueness + the `/^[a-z][a-z0-9_]*$/` regex gate the tool-naming convention (`mcp__<name>__<tool>`).

`McpValueSource` is a discriminated union over `kind`: `{kind:"literal", value}` or `{kind:"secret", name}`. Lets `env`/`headers` mix constants with encrypted secret refs in the same map.

### mcp_server_tools `[confirmed]`

Schema pin + per-tool approval. One row per tool exposed by a server.

```ts
{
  id: pk(),
  createdAt: ts(),
  serverId: uuid("server_id").references(() => mcpServers.id, { onDelete: "cascade" }).notNull(),
  toolName: text("tool_name").notNull(),     // server-local, without mcp__ prefix
  schemaHash: text("schema_hash").notNull(), // sha256({ description, inputSchema })
  schemaSnapshot: jsonbZod("schema_snapshot", ToolSchemaSnapshotSchema).notNull(),
  approvalStatus: pgEnum("pending" | "approved" | "rejected").notNull(),
  // unique(server_id, tool_name)
}
```

Pinning the hash defends against schema rug-pull (CyberArk-documented attack: Day-1-safe tool mutates Day-7 into exfil).

### Profile filtering

**Extend `profiles.toolSet` semantics in place.** Today it's a flat string array. Make entries support globs (`"mcp__github__*"`, `"mcp__linear__list_*"`) for both native and MCP tools — exact names still work. One field, both worlds. No new column.

### Secrets

Reuse `secrets` ([infrastructure.md](../infrastructure.md)) verbatim. `McpServerConfigSchema` references secrets by name through a typed `SecretRef`:

```ts
// `env` and `headers` are Record<string, McpValueSource>, where:
type McpValueSource =
  | { kind: "literal"; value: string }
  | { kind: "secret"; name: string };

// example stdio config
{
  transport: "stdio",
  command: "npx",
  args: ["@modelcontextprotocol/server-github"],
  env: {
    GITHUB_PERSONAL_ACCESS_TOKEN: { kind: "secret", name: "mcp:github:token" },
    NODE_ENV: { kind: "literal", value: "production" },
  },
}
```

The runner resolves and injects at spawn time. Naming convention `mcp:<server>:<key>` is documentation, not enforcement.

This avoids OpenCode's `{env:VAR}` interpolation hack — typed `SecretRef` is cleaner than string-templating.

## Interfaces

### McpRegistry (orchestrator-facing)

```ts
export interface McpRegistry {
  start(): Promise<void>;                    // process boot
  stop(): Promise<void>;                     // process shutdown

  // per conversation turn — returns ToolSpecs to merge with native registry
  resolveTools(opts: {
    profile: Profile;
    budget: number;                          // max MCP tools (default 25)
  }): Promise<readonly ToolSpec[]>;

  // admin operations (used by /settings UI, setup wizard, evolution)
  addServer(spec: McpServerSpec): Promise<McpServer>;
  removeServer(id: string): Promise<void>;
  listServers(): Promise<readonly McpServerStatus[]>;
  approveServer(id: string): Promise<void>;
  approveTool(serverId: string, toolName: string): Promise<void>;
}
```

Agent loop integration is one line in `handle-message`:

```ts
const mcpTools = await mcpRegistry.resolveTools({ profile, budget: MCP_TOOL_BUDGET });
const tools = [...registry.snapshot(), ...mcpTools];
```

`ToolRegistry` stays static; MCP merge is per-conversation. Stateless per invocation, per [architecture.md](../architecture.md).

### McpConnection (internal)

```ts
interface McpConnection {
  callTool(name: string, input: unknown, opts: { timeoutMs: number }): Promise<unknown>;
  listTools(): Promise<readonly McpToolDescriptor[]>;
  onToolsChanged(cb: () => void): () => void;
  close(): Promise<void>;
}
```

Tool naming: **`mcp__<server>__<tool>`** (Claude Code convention). Stable, glob-friendly, escape-safe through Telegram (already handled by [src/transport/adapters/telegram/index.ts](../../src/transport/adapters/telegram/index.ts) plain-text fallback).

## Lifecycle

### Process boot

`McpRegistry.start()` reads enabled servers from the store. **Lazy-connect nothing.** Subprocesses are spawned on first tool call per session.

### Connection establishment (lazy)

On first call to a server's tool:
1. Pool checks for live connection. None → runner spawns subprocess (or opens HTTP transport).
2. SDK Client `connect()` + `initialize` + `listTools()`.
3. Hash returned tool schemas, diff against `mcp_server_tools` rows.
   - Match: dispatch.
   - Mismatch / new tools: mark server `needs_reapproval`, return `tool_result` with `isError: true` ("server X has unapproved schema changes — ask user to /mcp approve"). LLM surfaces to user.

### Tool dispatch

- Per-call timeout (default **30s** — Claude Code's #1 failure mode is the missing timeout, [issue #15945](https://github.com/anthropics/claude-code/issues/15945)).
- On timeout or transport close: close connection, return tool error to the agent loop, attempt **one** reconnect on next call (Cursor pattern). Second failure: mark server unhealthy, surface to user.
- All MCP tool calls set `durable: true` on the adapted `ToolSpec` → wrapped in Inngest `step.run()`. Step memoization is correct because the MCP server is non-deterministic; retry of `handle-message` reuses the recorded tool result.

### Hot reload

Adding / disabling / editing a server invalidates the pool entry. Next call respawns with the new config. Match Cline's split:
- Config change (command, env) → restart subprocess.
- Toggle / approval / timeout change → no restart.

### Idle eviction

Connections idle > **10 min** torn down. Re-spawn on next demand. Bounds container / process count.

## Trust & sandboxing

### Trust model

Binary, **declared in code, not DB**:

```ts
const SHIPPED_TRUSTED_SERVERS: ReadonlySet<string> = new Set([
  // first-party servers shipped with Cogmo
]);
```

Anything not in the set is `untrusted`. Auditable in PR; can't be flipped at runtime by a compromised admin path.

This is a Cogmo-specific safety move — none of Claude Code, OpenCode, Cline, Cursor, Continue have a trust concept; they treat all servers equally. Goose has signed extensions, Docker MCP Gateway has a curated catalog. Closest prior art.

### Sandboxed execution (Phase B)

Reuse `Sandbox.createTaskContainer()` ([sandbox.md](../sandbox.md)) for stdio servers when untrusted:

- Read-only rootfs.
- No host bind mounts.
- Default-deny egress; per-server allowlist (e.g. `api.github.com:443`).
- CPU / memory caps.

Trusted servers run on the host (~100ms cold start vs ~1s for sysbox).

HTTP transports go through the Node `fetch` — no subprocess to sandbox. Defense is auth + URL allowlist only.

Docker's research found 43% of public MCP servers have command-injection flaws ([docker.com/blog/mcp-security-explained](https://www.docker.com/blog/mcp-security-explained/)). Running untrusted servers on the host is the actual risk; sandboxing puts Cogmo ahead of every consumer surveyed.

## Auth & secrets

**Phase A — manual tokens.** `env` vars and HTTP headers, with secret references resolved at spawn / request time from the encrypted secrets table. Typed `SecretRef` instead of string interpolation.

**Phase D — OAuth 2.1.** Spec-mandated PKCE + Dynamic Client Registration ([dev.to/composiodev MCP OAuth 2.1](https://dev.to/composiodev/mcp-oauth-21-a-complete-guide-3g91)). Refresh tokens stored encrypted in `secrets`. Refresh **proactively** before tool dispatch (gemini-cli #23296: refresh failing mid-call is a real footgun).

## Failure handling

| Failure | Mitigation |
|-|-|
| Tool hang | 30s per-call timeout; close connection on timeout |
| Transport drop (`-32000 Connection closed`) | Auto-reconnect once on next call; second failure marks server unhealthy |
| Schema rug-pull | SHA256 pin per tool; mismatch → `needs_reapproval`; tool calls fail until re-approved |
| Stdout pollution | Stdio strictly through SDK transport; server stderr → structured log |
| Tool count explosion | Hard budget (default 25 MCP tools) + glob filter |
| Tool-description prompt injection | Show description to user at approval time; future: heuristic flag for high-risk strings |
| Localhost binding | We don't host MCP servers — N/A |

Tool budget rationale: Cursor's hard ~40-tool cap is real ([forum.cursor.com](https://forum.cursor.com/t/about-limitation-of-the-number-of-mcp-tools/107844)) because (a) prompt token cost, (b) LLM tool-selection accuracy degrades after ~30. Over budget → drop alphabetically and emit a steering note.

## Hindsight: native client, not MCP

Hindsight ships an MCP server ([hindsight.vectorize.io/developer/mcp-server](https://hindsight.vectorize.io/developer/mcp-server)) exposing 26-29 tools — a strict subset of its full HTTP API. Their docs do **not** state a preference between API and MCP.

**Decision: keep the native HTTP client (`MemoryProvider`) for Cogmo's own memory; do not route it through MCP.**

| Reason | Detail |
|-|-|
| Hot path | Auto-recall runs every turn. JSON-RPC roundtrip + tool-shape adapter + schema pinning is pure overhead. |
| Typed contract | Orchestrator depends on `service.memory.recall(...)` directly. Routing through MCP loses that. |
| Cogmo-specific semantics | Observer extraction, profile tags as bank scoping, four-network model don't map cleanly onto generic tool surface. |
| Validation forcing function | Day-1 dogfooding wants a real third-party server (GitHub) — not our own first-party dependency. |

Update [integrations.md](../integrations.md) — "Hindsight | Native MCP server | Day 1" row was aspirational and should be removed.

## Per-user vs global servers

**Phase A: global.** Single user; `mcp_servers` is unscoped.

**When multi-tenant lands:** add `userId NOT NULL`. Real benefits are downstream:
- Per-user GitHub PAT (without scoping, user-scoped secrets under a global server are semantically muddled).
- Per-user enable / disable.
- Tenant isolation.

Don't half-do it now — add `userId` in the same migration that wires up multi-tenant elsewhere.

## Approval UX

Two distinct decisions, two distinct UIs:

| Decision | When | UI |
|-|-|-|
| **Server-level approval** (this server is OK to run; these tools are OK to expose) | Once, on add or schema-change | `/mcp approve <server>` Telegram command — async, reviewable, shows tool descriptions before approval |
| **Per-call approval** (run this specific call right now) | Per call, only if a future risk tier requires it | Existing coding-delegation permission-prompt flow — inline button |

Phase A only needs server-level approval. Per-call is deferred until a concrete tier requires it.

## Testing

| Tier | What |
|-|-|
| Unit | Mock `McpConnection`. Test `McpToolAdapter` (ToolSpec generation, schema hashing), glob filtering, budget cap, profile resolution. PGlite for store. |
| Integration | Spin up `@modelcontextprotocol/server-everything` (official reference server, npm package) as stdio child in tests. Assert: list, call, hot-reload, schema-drift detection, timeout, reconnect. |
| E2e | One real server (GitHub) gated behind `MCP_E2E=1` — manual / nightly only. |

`mcpRegistry` is mocked at the orchestrator boundary in `handle-message` integration tests. No new llmock fixtures needed unless tool descriptions change LLM output enough to drift recordings — re-record if so ([testing.md](../testing.md) → "Re-record when requests change").

## Decisions captured

| Decision | Rationale |
|-|-|
| `mcp__<server>__<tool>` naming | Claude Code convention. Glob-friendly. Escape-safe through existing Telegram plain-text path. |
| Per-request tool merge, not registry mutation | Stateless per invocation. Profile filtering composes naturally. |
| Process-singleton lazy-connect pool | Per-Inngest-step factory pays full cold-start every call (~100-500ms stdio). Singleton matches Claude Code, Cursor, Cline. |
| Trust as code-level allowlist, not DB column | Auditable in PR; can't be flipped at runtime. |
| Schema-hash pinning per tool | Defends against rug-pull. CyberArk MCPTox: Claude 3.7-Sonnet refused <3% of attacks ([practical-devsecops.com](https://www.practical-devsecops.com/mcp-security-vulnerabilities/)). |
| Tools-only in v1 | 80% of real servers are tools-only. Resources / prompts deferred until concrete use case. |
| Native HTTP client for Hindsight, not MCP | Hot path; typed contract; Cogmo-specific semantics. |
| Extend `profiles.toolSet` with globs in place | Symmetry with native tools. Backwards compatible. |
| Budget cap (25) | LLM tool-selection accuracy degrades > ~30 (Cursor data). |
| Use the official `@modelcontextprotocol/sdk` | ~17 transitive deps including unused server-side HTTP frameworks (express, hono, ajv, jose, pkce-challenge, eventsource — the SDK ships client + server in one package, no split available as of 2026-05). Accepted because runtime cost is zero (server-side TS, no browser bundle) and tracking spec changes upstream is more valuable than dep minimalism. Alternatives evaluated: `mcp-use` (smaller, but lags spec), hand-rolled JSON-RPC client (~300-500 LOC, no help when OAuth lands in Phase D). Re-evaluate if a CVE in the unused server path forces it. |

## Open questions

None blocking Phase A. Re-evaluate before Phase D (OAuth) and Phase E (resources / prompts).

## References

- [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Agent SDK MCP](https://platform.claude.com/docs/en/agent-sdk/mcp), [issue #15945](https://github.com/anthropics/claude-code/issues/15945)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [Cline MCP](https://docs.cline.bot/mcp/configuring-mcp-servers)
- [Cursor MCP](https://cursor.com/docs/mcp), [tool count limits](https://forum.cursor.com/t/about-limitation-of-the-number-of-mcp-tools/107844)
- [Continue MCP tools](https://docs.continue.dev/customize/mcp-tools), SEP-1300 Tool Groups
- [Goose MCP](https://block.github.io/goose/docs/mcp/jetbrains-mcp/)
- [@modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [mcp-use multi-server](https://mcp-use.com/docs/typescript/advanced/multi-server-setup)
- [Docker MCP security](https://www.docker.com/blog/mcp-security-explained/)
- [CyberArk: Poison Everywhere](https://www.cyberark.com/resources/threat-research-blog/poison-everywhere-no-output-from-your-mcp-server-is-safe)
- [PracticalDevSecOps MCPTox](https://www.practical-devsecops.com/mcp-security-vulnerabilities/)
- [MCP OAuth 2.1 guide](https://dev.to/composiodev/mcp-oauth-21-a-complete-guide-3g91)
- [Hindsight MCP server](https://hindsight.vectorize.io/developer/mcp-server)
