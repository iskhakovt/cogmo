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

## Integration Tests `[proposed]`

Test real interactions with PostgreSQL and Redis. Use Docker Compose for local dev (`docker-compose.yml`), or a separate `assistant_test` database.

| Test | What |
|-|-|
| Hindsight round-trip | `retain()` -> `recall()` returns the fact |
| Inngest job flow | Enqueue job -> worker processes -> result in DB |
| Schema migrations | Apply all migrations to empty DB, verify tables |
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
