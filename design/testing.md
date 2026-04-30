# Testing

## Local Development `[confirmed]`

Direct channel + console script for dev/test. Start infra + app, interact in a separate terminal:

```bash
pnpm dev:infra          # start infra + seed + app
pnpm console            # interactive console (separate terminal)
```

## Unit Tests `[confirmed]`

Use Vitest (fast, native TS, ESM). Test what's deterministic:

| Layer | What to test | How |
|-|-|-|
| Store implementations | Drizzle queries against real SQL | PGlite (in-process PG17 WASM), `pushSchema` from `drizzle-kit/api` |
| Typed LLM calls | Zod schema validation, retry logic | Mock the SDK client, inject known responses |
| Adapter modules | Setup, deliver, inbound handling | Mock Transport, use shared test factories |
| Prompt assembly | System prompt + rules + memories | Mock AgentStore |
| Transport | Session resolution, emit, conversation creation | Mock stores |
| Respond | Message loading, session filtering, delivery | Mock stores + adapter |

Shared test factories in `src/test/factories.ts` — `mockAgentStore()`, `mockTransportStore()`, `mockTransport()`, `mockAdapter()`, `mockStep()`, etc.

**PGlite setup:** `src/test/pglite.ts` — `createTestDatabase()` boots PGlite with `pg_uuidv7` extension, applies schema via `pushSchema`, returns driver-agnostic `Database` type. `truncateAll()` clears tables between tests.

**Naming:** `.test.ts` suffix. `pnpm test`.

## Integration Tests `[confirmed]`

Docker services + app wired in-process. Tests the orchestration pipeline — debuggable, injectable, faster than e2e.

**Infrastructure:**
- Testcontainers (PostgreSQL, Redis, Inngest, Hindsight) — started in vitest `globalSetup`, random ports
- Container definitions in `dev/containers.ts` (shared with `scripts/dev-infra.ts` for local dev)
- llmock (`@copilotkit/llmock`) runs in-process — serves both Anthropic API (for app) and OpenAI-compatible API (for Hindsight, replacing Ollama)
- Hindsight reaches llmock via `host.docker.internal`
- App modules imported directly — `bootstrap()` from `src/index.ts` wires everything

**Env injection:** `process.env` mutations in `globalSetup` propagate to Vitest test workers. Dynamic container URLs set via `process.env`, static values in `vitest.config.ts` `test.env`. Test files use normal top-level imports — `createEnv()` in `env.ts` sees all values.

**Naming:** `.integration.test.ts` suffix. `pnpm test:integration`.

| Test | What |
|-|-|
| Pipeline | `bootstrap()` in-process, emit `inbound/arrived` → assert assistant message in DB |
| Hindsight round-trip | `retain()` → `recall()` returns the fact (llmock provides instant deterministic responses) |

## E2E Tests `[confirmed]`

Full deployment-like stack — cogmo as a subprocess in connect mode. Smoke test.

**Infrastructure:**
- Testcontainers (PostgreSQL, Redis, Inngest, Hindsight) — started in vitest `globalSetup`
- llmock in-process — replaces both mock-anthropic container and Ollama
- App spawned as subprocess with connect mode (WebSocket to Inngest dev server)
- Seed runs before app start (`tsx src/cli.ts seed`)

**Naming:** `.e2e.test.ts` suffix. `pnpm test:e2e`.

| Test | What |
|-|-|
| Migrations | App subprocess applies migrations on boot. Verify tables queryable. |
| Smoke | Emit one event via Inngest API → assert assistant response in DB |

## Coverage Patterns `[confirmed]`

Concrete test recipes that should be applied alongside the tier guidance above. Distilled from the audit of Phase 6 P1 PRs (#76 / #78 / #80 / #86), shipped 2026-04-30.

### JSONB raw-SQL bypass tests

Every JSONB column has a Zod schema enforced at the store boundary on **both** read and write (CLAUDE.md → Architecture Rules). Tests must exercise both directions — write-side via `insertX({ malformed })` is the easy half; read-side requires bypassing the writer:

```ts
await db.execute(sql`UPDATE <table> SET <col> = '{"junk":true}'::jsonb WHERE id = ${id}`);
await expect(store.getX(id)).rejects.toThrow();
```

Reference: `src/skills/store/store.test.ts` "rejects malformed classifier_log via raw SQL on read"; `src/sandbox/store/store.test.ts` for `containers.labels` / `resource_limits` etc.

### Discriminated-union exhaustive parse tests

Every union arm should have a positive test (valid input → expected variant) and a negative test (invalid shape → rejected or fallback). Particularly for parsers consuming external streams (CLI stream-json, webhook payloads). Pin the *permissive* arms explicitly — "unknown event type silently dropped" is a contract worth a test, since a refactor that starts throwing would surface as a runtime crash otherwise.

Reference: `src/agent/coding/claude.test.ts → describe("ClaudeCodeBackend stream-json schema robustness")`.

### Store happy-path + error-path coverage matrix

Beyond "insert then retrieve":
- **Atomic multi-field state** — JSONB blobs that group correlated fields (e.g. `worktree_assignment: {branch, worktreePath}`) should have null-until-both-set + reject-half-set tests.
- **Idempotent replay** — store methods invoked twice (Inngest retry simulation) produce the same terminal state without errors.
- **Missing-row behaviors** — `getById("nonexistent")` returns `null`, not throws.
- **Constraint collisions** — UNIQUE / FK violations surface as the right typed error (e.g. `UniqueViolationError` mapped to `repo_name_taken`).

### Error-path coverage matrix per module

For each command surface (CLI tool, orchestrator function, Telegram command), enumerate and test:
- Invalid args (per Zod schema)
- Missing required effects / dependencies (e.g. `service.coding` not provided)
- External service timeout / auth failure
- Concurrent contention (atomic conditional updates losing the race)
- Idempotent retries
- Cleanup on crash (try/finally invariants pinned)

### Resource cleanup invariants

Every operation that allocates a resource (worktree, container, askpass dir, advisory lock) needs a test asserting the cleanup path runs even when the operation fails mid-flight. The `try/finally` is the typical implementation; the test is a fake sandbox / store where the operation throws and the asserter checks the resource is gone.

Reference: `src/sandbox/supervisor.test.ts` "stopTask still calls cleanupAskpass when Docker kill throws"; `src/agent/coding/teardown.test.ts`.

### Audit row invariants ("every X produces a Y")

Cross-module contracts that no single module test can verify:
- Every `setTaskStatus(...)` produces the corresponding `coding/task/<status>` event on the bus.
- Every tool permission decision produces a `coding_tool_decisions` row with the correct scope.
- Every `ctx.*` skill RPC produces a `skill_context_calls` audit row with method + target.

These belong in **integration tests** that exercise the orchestrator + event bus + audit table together, not in module-isolated unit tests.

### CLI exit-code matrices

For every command surface (Telegram `/repo`, agent tools), enumerate the discriminated error codes and pin the user-visible response per code. Prevents drift where a new error code returns a generic fallback instead of a tailored message.

Reference: `src/transport/adapters/telegram/repo-commands.test.ts`; `src/agent/coding/tool.test.ts`.

### Version-pinning canaries

Runtime deps with breaking-change history (octokit, dockerode, sysbox image tags, Claude CLI flag set) deserve explicit tests that the API surface our code uses still exists. Today a runtime regression only surfaces in integration tests; a unit-tier schema validation against the SDK's request/response types catches it earlier.

(Currently aspirational — listed in PROGRESS.md → Phase 6 → Test infrastructure as a future canary.)

### Concurrency invariants

For in-process pub/sub (`CodingStreamingRegistry`, `EventEmitter` wrappers): pin listener-set snapshot semantics (subscribers added mid-emit don't fire for the in-flight event), self-unsubscribe-during-emit, re-entrant publish, and burst ordering across multiple subscribers. Catches refactors that introduce async dispatch or live-iteration regressions.

For SQL-level atomic operations (`approvePlanIfPending`, `transitionTaskStatus`): the atomic SQL is the contract; module tests verify the discriminated outcomes (`approved` / `already_approved` / `not_pending`). End-to-end "two concurrent Telegram callbacks" tests are deferred to the integration tier with real Postgres.

Reference: `src/agent/coding/streaming-registry.test.ts → describe("concurrency invariants")`.

## Telegram Testing `[confirmed]`

- **Unit (current):** `vi.mock("grammy")`, mock Transport. Tests adapter logic without network.
- **Unit (future enhancement) `[proposed]`:** grammY `bot.handleUpdate()` + `bot.api.config.use(transformer)` — tests against real grammY framework, catches API contract drift. Tracked as `p3` in `todo.md`.
- **E2e (future) `[research]`:** Telegram Test DC + tgintegration (TypeScript/mtcute). Real user on Telegram's test servers. Network-dependent, run on schedule. Tracked as `p3` in `todo.md`.

## LLM Tests (Non-Deterministic) `[research]`

LLM outputs vary. Test with assertions on structure, not exact content:

```typescript
// Good: test structure
const result = await extractMemories(transcript);
expect(result).toBeArray();
expect(result[0]).toHaveProperty('fact');
expect(result[0]).toHaveProperty('network');
expect(['world', 'bank', 'opinion', 'observation']).toContain(result[0].network);

// Bad: test exact content
expect(result[0].fact).toBe("User prefers dark mode");
```

For evolution Stage 4+, use LLM-as-judge rubrics with held-out test sets. Track scores over time — regression = prompt change broke something.

## Mocking External Services `[confirmed]`

| Service | Mock strategy |
|-|-|
| Anthropic API | llmock — fixture-based HTTP server, supports streaming + tool_use |
| Ollama (for Hindsight) | llmock — same instance, serves OpenAI-compatible endpoints |
| MCP servers | Stub MCP client with fixed tool results |
| Telegram | grammY `vi.mock` (unit), Test DC + tgintegration (e2e, future) |
| Gmail/Calendar | Record real responses, replay in tests |

## Evaluation Dataset `[research]`

Build incrementally from real conversations (Phase 4 prerequisite):

1. After ~20 conversations: extract passing traces as few-shot examples
2. After ~50 conversations: label a held-out set for automated evaluation
3. Score new prompt variants against held-out set before promoting

Store in `evaluation/` directory: `evaluation/traces/`, `evaluation/rubrics/`, `evaluation/held-out/`.
