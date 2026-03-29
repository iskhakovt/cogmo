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
| Typed LLM calls | Zod schema validation, retry logic | Mock the SDK client, inject known responses |
| Memory metadata | Salience scoring, network routing | Pure functions, no LLM |
| Adapter modules | Setup, deliver, inbound handling | Mock Transport, use shared test factories |
| Tag stripping | `<internal>` removal | String in, string out |
| Prompt assembly | System prompt + rules + memories | Mock AgentStore |
| Transport | Session resolution, emit, conversation creation | Mock stores |
| Respond | Message loading, session filtering, delivery | Mock stores + adapter |

Shared test factories in `src/test/factories.ts` — `mockAgentStore()`, `mockTransportStore()`, `mockTransport()`, `mockAdapter()`, `mockStep()`, etc.

## Integration Tests `[confirmed]`

All services run in Docker (testcontainers), test runner seeds the DB and sends events.

**Infrastructure:**
- Individual testcontainers (PostgreSQL, Redis, Inngest, Hindsight) — started in vitest `globalSetup`, random ports
- Container definitions in `test/containers.ts` (shared with `scripts/dev-infra.ts` for local dev)
- `pnpm test:integration` runs them, `pnpm test` runs unit only
- Seed runs before app start (`tsx src/cli.ts seed`)

**Mock LLM:** Separate container running a tiny HTTP server that implements `POST /v1/messages` with canned responses. App points `ANTHROPIC_BASE_URL` at it — zero test code in production.

**Inngest:** Uses `inngest dev` (not `inngest start`) for integration tests. Dev mode skips auth, stores state in memory. We're testing our app's event flow, not Inngest's durability.

**Naming:** `.integration.test.ts` suffix, co-located with source. Vitest projects config separates unit from integration.

| Test | What |
|-|-|
| Full pipeline | Seed DB, create session + inbound, emit `inbound/arrived` → assert assistant message in DB |
| Schema migrations | App starts = migrations applied. Verify tables queryable. |
| Hindsight round-trip | `retain()` -> `recall()` returns the fact |

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

## Mocking External Services `[proposed]`

| Service | Mock strategy |
|-|-|
| Anthropic SDK | Inject mock client returning canned responses |
| MCP servers | Stub MCP client with fixed tool results |
| Telegram | grammY mock bot (vi.mock), Transport mock |
| Gmail/Calendar | Record real responses, replay in tests |

## Evaluation Dataset `[research]`

Build incrementally from real conversations (Phase 4 prerequisite):

1. After ~20 conversations: extract passing traces as few-shot examples
2. After ~50 conversations: label a held-out set for automated evaluation
3. Score new prompt variants against held-out set before promoting

Store in `evaluation/` directory: `evaluation/traces/`, `evaluation/rubrics/`, `evaluation/held-out/`.
