# Testing

## Principles

- **One module per test file** — each `.test.ts` tests exactly one source module. Mock everything outside that module.
- **Design for testability** — accept interfaces, not concrete classes. Pass dependencies (db, provider) as parameters, not imports. If something is hard to test, the design is wrong — fix the design, not the test.
- **Test contracts, not internals** — test the interface a consumer depends on. If changing an implementation detail breaks a test, the test is too coupled. If a contract changes and no test breaks, there's a gap.
- **Boundary behavior matters** — defensive copies, error propagation, unknown/missing inputs, edge cases at module boundaries. This is where real bugs live.
- **Test helpers for readability** — factory functions (`mockProvider()`, `textResponse()`) keep tests scannable. Prefer building test data declaratively over inline object literals repeated across tests.
- **Mock interfaces with `mock<T>()` from `vitest-mock-extended`, not `as any`.** For any stub of a project-owned interface (`MemoryProvider`, `SecretsStore`, `SkillStore`, `Service`, etc.), use `mock<T>()` — it returns a typed `MockProxy<T>` with every method as a `vi.fn()`, no casts needed. Override individual methods with `.mockResolvedValue(...)` / `.mockImplementation(...)`. **Do not write** `{ partial fields } as any` to satisfy a typed dep. *Three known caveats:* (1) **Absent optional sub-namespaces don't work via assignment.** `mock<Service>()` returns a Proxy that auto-mocks on every access, including optional fields like `coding`/`skills`. `svc.coding = undefined` is blocked by `exactOptionalPropertyTypes`, and `delete svc.coding` doesn't stick — the Proxy re-mocks on the next read, so a test that exercises the "service is unavailable" path still sees `service.coding.delegate is not a function`. Hand-build the stub instead, mocking the always-present sub-namespaces and using conditional spread for the optional ones: `{ memory: mock<Service["memory"]>(), files: mock<Service["files"]>(), coreMemory: mock<Service["coreMemory"]>(), ...(coding !== undefined && { coding }) }`. See `src/agent/coding/tool.test.ts` and `src/skills/skills-tool.test.ts`. (2) Stateful test fixtures with custom call-tracking (e.g. the dockerode stubs in `src/sandbox/supervisor.test.ts` / `reaper.test.ts`) and partial third-party types where only one method is exercised (`{ send } as any` for Inngest) stay as targeted partial casts — `mock<T>()` doesn't help when the value of the test IS the stateful tracking. (3) `mock<Service>()` similarly auto-mocks every nullable field, including ones a test wants to read as `null` for default behavior — assign explicitly when the contract under test depends on `null` vs. defined.
- **Narrow without `!` or `as`.** Use the helpers in `src/test/assertions.ts` instead of writing `events[4] as Extract<CodingEvent, { kind: "plan_ready" }>` or `arr[0]!`. `expectDefined<T>(value, label)` returns the narrowed `T` and throws if null/undefined — for `arr[i]`, `map.get(k)`, `.find(...)`, `mock.calls[0]`. `assertKind<U,K>(value, kind)` uses an `asserts value is …` annotation to narrow a discriminated-union variant in place: `const planReady = events[4]; assertKind(planReady, "plan_ready"); expect(planReady.plan)…` works without a cast at the call site. Cast-free narrowing keeps the type checker honest — a wrong `kind` literal is a compile error rather than a silent runtime miscoercion.
- **Deep-merge `Transport` overrides via `mockTransportDeep`.** `mockTransport({ conversations: { list: vi.fn()… } })` requires the *full* `Transport["conversations"]` shape and breaks every time a new method is added to the namespace. `mockTransportDeep({ conversations: { list: vi.fn()… } })` from `src/test/factories.ts` deep-merges the override into each sub-namespace (`conversations`, `profiles`, `coding`, `skills`, `repos`, `models`, `mcp`) and keeps `mockTransport()`'s defaults for the rest. Use it whenever a test only cares about one method on a namespace.
- **Coverage patterns** — `design/testing.md` → "Coverage Patterns" lists concrete recipes (JSONB raw-SQL bypass, discriminated-union parse tests, audit invariants, error-path matrix, resource-cleanup invariants, concurrency invariants, CLI exit-code matrix). Apply to new test code.
- **Integration tests pass in isolation, ship in parallel.** Vitest's integration tier runs files in parallel forks by default — that's the deployment model, not an implementation detail. Before declaring an integration test stable, run it alongside its noisiest peers (`pnpm test:integration --run a.test.ts b.test.ts`), not just `--run my.test.ts`. Tests that bootstrap shared infrastructure (Inngest connect, sockets, port bindings, advisory locks, Postgres rows that other tests query) collide under parallel forks in ways single-file runs hide. CI passing isn't proof either — slower runners can give timing windows that don't exist locally; when local fails and CI passes, suspect CI luck first and reproduce on the prior committed state (`git stash` + rerun) before blaming local environment. If a test relies on per-fork state but participates in a shared event/RPC bus, that's a design bug — fix the design (e.g. move the resource to `globalSetup` and `provide()` its URL), don't paper over with retries or sequential pragmas.
- **Framework:** Vitest. See `design/testing.md` for full details.

## Three-Tier Structure

| Tier | Infra | App | LLM | What it proves |
|-|-|-|-|-|
| **unit** `.test.ts` | PGlite (in-process) | mocked / direct | mocked | Module logic, store queries, contracts |
| **integration** `.integration.test.ts` | Docker (PG, Redis, Inngest, Hindsight) + llmock | in-process | llmock fixtures | Pipeline orchestration, memory round-trip, event routing |
| **e2e** `.e2e.test.ts` | Docker (full stack) + llmock | subprocess | llmock fixtures | Binary boots, migrations apply, full stack smoke |

Commands: `pnpm test` (unit), `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:all`.

## Store Tests with PGlite

Store implementations (`DrizzleAgentStore`, `DrizzleTransportStore`) are tested against real SQL via PGlite — an in-memory WASM PostgreSQL (PG18, the same major as the `pgvector/pgvector:pg18` image dev and prod run). No Docker needed.

- **Schema:** Applied via `pushSchema()` from `drizzle-kit/api` — no migration files in tests.
- **UUIDs:** `uuidv7()` comes from PostgreSQL 18 core — no extension, no alias.
- **Type:** `Database` is `PgDatabase<PgQueryResultHKT, schema>` — driver-agnostic. Works with postgres-js, PGlite, or any Drizzle PG driver. No `as any` casts needed.
- **Cleanup:** Truncate all tables via `db.execute(sql\`...\`)` between tests. One PGlite instance per test file.
- **Helper:** `src/test/pglite.ts` — `createTestDatabase()` and `truncateAll()`.

## Record/replay mocks (LLM + fal + voice + xAI + Daytona)

Integration tests run against frozen wire fixtures captured from real upstreams. CI replays for free; recordings happen locally once per drift. Five mocks share the same `RECORD=1` env flag:

| Mock | Location | What it captures |
|-|-|-|
| llmock (`@copilotkit/aimock`) | `test/llmock-setup.ts` | Anthropic `/v1/messages` + OpenAI `/v1/chat/completions` + `/v1/embeddings` (for Hindsight) |
| fal-mock | `src/test/fal-mock.ts` | fal.ai image generation, scoped `fetch` wrapper |
| openai-voice-mock | `src/test/openai-voice-mock.ts` | OpenAI `/v1/audio/{speech,transcriptions}` for TTS/STT |
| xAI llmock | `src/test/xai-grok.integration.test.ts` | One-off llmock proxying `openai → openrouter.ai/api` |
| daytona-mock | `src/test/daytona-mock.ts` | `@daytonaio/sdk` REST + WebSocket (toolbox proxy, `getSessionCommandLogs`) |

**To re-record:** `pnpm test:record` (or `:e2e`) sets `RECORD=1` and runs the integration tier. Each mock guards on its own upstream API key — only adapters with keys present in `.env` actually record. CI never sets `RECORD=1`; unmatched requests fail with `503` (or `1011` for WS) carrying a "re-record" hint.

**When to re-record:** prompt structure changes, new tools in the system prompt, auto-recall on/off, model swap, SDK version bump for daytona/fal/etc. The failing test's error surface points at the fixture file that needs refreshing.

**Sandbox-id and other stable identifiers in URLs:** fixture matching is `(method, path)` FIFO. Random per-test UUIDs that appear in URLs (`sessionId`, etc.) must be pinned to fixed strings in the test, otherwise the recorded path won't match the replay path. Body-only identifiers (labels, request payloads) can stay random — body comparison is intentionally loose.

## Integration Test Env Injection

`process.env` mutations in Vitest `globalSetup` propagate to test workers (worker env = `{ ...process.env, ...config.env }`). Dynamic values (container URLs, `COGMO_MASTER_KEY`) are set via `process.env` in globalSetup. Static values (`NODE_ENV`) go in `vitest.config.ts` `test.env`. Test files use normal top-level imports — `createEnv()` in `env.ts` sees all values.

## Telegram Testing

- **Unit:** grammY transformers + `handleUpdate()` for testing adapter logic without network. Current tests use `vi.mock("grammy")` — future enhancement to use grammY's built-in test primitives.
- **Integration:** Not tested — integration tier uses Direct adapter.
- **E2e (future):** Telegram Test DC + tgintegration (TypeScript/mtcute). Real user account on Telegram's test servers.
