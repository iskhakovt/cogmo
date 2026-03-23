# Testing

## Local Development `[proposed]`

CLI adapter (`src/channels/cli.ts`) is the primary dev/test interface. stdin/stdout, no Telegram needed. Start with:

```bash
pnpm dev  # tsx watch mode
```

Type messages, see agent responses, memory operations, and tool calls in structured log output.

## Unit Tests `[confirmed]`

Use Vitest (fast, native TS, ESM). Test what's deterministic:

| Layer | What to test | How |
|-|-|-|
| Typed LLM calls | Zod schema validation, retry logic | Mock the SDK client, inject known responses |
| Memory metadata | Salience scoring, network routing | Pure functions, no LLM |
| Channel registry | Registration, factory pattern | No external deps |
| Scheduler | Job creation, cron parsing | Mock Inngest queue |
| Tag stripping | `<internal>` removal | String in, string out |
| Session lifecycle | Idle detection, conversation boundaries | Time-based logic |
| Prompt assembly | System prompt + rules + memories | Template rendering |

## Integration Tests `[confirmed]`

True E2E: all services run in Docker, test runner talks to them like a client.

**Infrastructure:**
- Single `docker-compose.yml` with profiles: base services (postgres, redis, inngest) always, test services (assistant app, mock-anthropic) via `--profile test`
- `compose.override.yml` adds fixed port mappings for dev. Testcontainers ignores overrides — gets random ports.
- Testcontainers `DockerComposeEnvironment` in vitest `globalSetup` manages lifecycle (up/down)
- `pnpm test:integration` runs them, `pnpm test` runs unit only

**Mock LLM:** Separate container running a tiny HTTP server that implements `POST /v1/messages` with canned responses. App points `ANTHROPIC_BASE_URL` at it — zero test code in production.

**Inngest:** Uses `inngest dev` (not `inngest start`) for integration tests. Dev mode skips auth, stores state in memory. We're testing our app's event flow, not Inngest's durability. May revisit with `inngest start` + postgres/redis if we need to test durable execution guarantees.

**DB isolation:** Schema-per-test with `CREATE SCHEMA` + `DROP SCHEMA CASCADE`. Avoids FK ordering headaches, parallel-safe.

**Naming:** `.integration.test.ts` suffix, co-located with source. Vitest projects config separates unit from integration.

| Test | What |
|-|-|
| Full pipeline | Send `message/received` event → assert conversation + messages in DB, response event emitted |
| Schema migrations | App starts = migrations applied. Verify tables queryable. |
| Hindsight round-trip | `retain()` -> `recall()` returns the fact |
| Crash recovery | Write cursor, simulate crash, resume from cursor |

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
| Telegram | CLI adapter (same Channel interface, no network) |
| Gmail/Calendar | Record real responses, replay in tests |

## Evaluation Dataset `[research]`

Build incrementally from real conversations (Phase 4 prerequisite):

1. After ~20 conversations: extract passing traces as few-shot examples
2. After ~50 conversations: label a held-out set for automated evaluation
3. Score new prompt variants against held-out set before promoting

Store in `evaluation/` directory: `evaluation/traces/`, `evaluation/rubrics/`, `evaluation/held-out/`.
