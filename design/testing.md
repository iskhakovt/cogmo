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

## Telegram Testing `[proposed]`

- **Unit (current):** `vi.mock("grammy")`, mock Transport. Tests adapter logic without network.
- **Unit (future enhancement):** grammY `bot.handleUpdate()` + `bot.api.config.use(transformer)` — tests against real grammY framework, catches API contract drift.
- **E2e (future):** Telegram Test DC + tgintegration (TypeScript/mtcute). Real user on Telegram's test servers. Network-dependent, run on schedule.

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
