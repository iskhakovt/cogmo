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
- **Mock call history resets between tests; implementations don't.** `clearMocks` is on — it is Vitest 5's default, not something `vitest.config.ts` sets, so don't go looking for it there. Vitest runs `.mockClear()` on every spy before each test. A `beforeAll` that installs `mockResolvedValue`/`mockReturnValueOnce` still holds for the whole file, but `mock.calls` starts empty in every test — assert call counts inside the test that makes the calls, never across tests. Use `mockReset()` when the implementation itself has to go. `restoreMocks` and `mockReset` are both off, so a `vi.spyOn` on a module-level singleton stays installed for the rest of the file unless the test restores it (`spy.mockRestore()`, or a file-level `vi.restoreAllMocks()`).
- **Coverage patterns** — `design/testing.md` → "Coverage Patterns" lists concrete recipes (JSONB raw-SQL bypass, discriminated-union parse tests, audit invariants, error-path matrix, resource-cleanup invariants, concurrency invariants, CLI exit-code matrix). Apply to new test code.
- **Integration tests pass in isolation, ship in parallel.** Vitest's integration tier runs files in parallel forks by default — that's the deployment model, not an implementation detail. Before declaring an integration test stable, run it alongside its noisiest peers (`pnpm test:integration --run a.test.ts b.test.ts`), not just `--run my.test.ts`. Tests that touch what files share (Inngest connect, sockets, port bindings, Docker containers, a Hindsight bank — see Integration Test Isolation below) collide under parallel forks in ways single-file runs hide. CI passing isn't proof either — slower runners can give timing windows that don't exist locally; when local fails and CI passes, suspect CI luck first and reproduce on the prior committed state (`git stash` + rerun) before blaming local environment. If a test relies on per-fork state but participates in a shared event/RPC bus, that's a design bug — fix the design (e.g. move the resource to `globalSetup` and `provide()` its URL), don't paper over with retries or sequential pragmas.
- **A red integration run outranks a green one, whichever side it came from.** The bullet above covers local-fail/CI-pass. The mirror case is local-pass/CI-fail, and it is equally not luck: a 2-core runner overlaps files differently from a 10-core workstation, and an uncached run orders them by size, so a file overlaps different neighbours on the resources files still share. So neither green clears a change: explain the red run, and never let the green side stand as the explanation. Which side is red tells you where to look — CI-only points at fork count and file order, local-only at timing windows a slower runner papers over — and a change touching anything a cassette depends on (the model a profile carries, the order turns are issued, which rows a suite writes) needs the failing configuration reproduced, not a rerun until it agrees with you.
- **Framework:** Vitest. See `design/testing.md` for full details.

## Test Tiers

| Tier | Infra | App | LLM | What it proves |
|-|-|-|-|-|
| **unit** `.test.ts` | PGlite (in-process) | mocked / direct | mocked | Module logic, store queries, contracts |
| **integration** `.integration.test.ts` | Docker (PG, Redis, Inngest, Hindsight) + llmock | in-process | llmock fixtures | Pipeline orchestration, memory round-trip, event routing |
| **e2e** `.e2e.test.ts` | Docker (full stack) + llmock | subprocess | llmock fixtures | Binary boots, migrations apply, full stack smoke |
| **live** `.live.test.ts` | none, or the integration stack | in-process | real provider APIs | Provider behaviour replay can't show — e.g. that prompt caching actually reads (`design/prompt-caching.md` → Live tier) |

Commands: `pnpm test` (unit), `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:all`, `pnpm test:live` (skipped unless `LIVE=1` and the provider's key is set; costs real money; never on PRs).

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
| daytona-mock | `src/test/daytona-mock.ts` | `@daytona/sdk` REST + WebSocket (toolbox proxy, `getSessionCommandLogs`) |

**To re-record:** `pnpm test:record` (or `:e2e`) sets `RECORD=1` and runs the integration tier. Each mock guards on its own upstream API key — only adapters with keys present in `.env` actually record. CI never sets `RECORD=1`; unmatched requests fail with `503` (or `1011` for WS); llmock's `503` names the closest fixtures and where each differs (Cassettes below).

**Cassettes.** llmock recordings live under `test/fixtures/recorded/`, one directory per consumer, and a recording lands in the cassette of the llmock that proxied it:

| Cassette | Consumer | Served by |
|-|-|-|
| `suites/<file>/` | one integration file's own calls; `<file>` is its name without `.integration.test.ts` | that file's llmock |
| `hindsight/` | the shared Hindsight container's embedding and extraction calls | `globalSetup`'s llmock, the only one a container reaches |
| `e2e/` | the e2e stack, app and Hindsight alike | the e2e setup's llmock |

Hindsight's cassette is one pool for every file, which is safe because its keys are content (fact text, transcript) and its state is per bank. A file's llmock fails it in two ways. A request its cassette cannot answer fails the test that was running, naming the request's key and the closest fixtures, the same account as the `503` body. A miss fails the test even when the client tolerates the 503 (the Claude CLI's background calls), so a devbase CLI bump means re-recording `claude-cli` on a host that runs it. And when every test in the file ran and passed, a cassette file nothing requested fails the file (otherwise it is only printed as a warning): a stale or superseded recording, which `test:record` leaves behind because it appends. Delete what it names. `globalSetup` also refuses a cassette with no file left to consume it.

**When to re-record:** prompt structure changes, new tools in the system prompt, auto-recall on/off, model swap, SDK version bump for daytona/fal/etc. The failing test's error surface points at the fixture file that needs refreshing.

**Sandbox-id and other stable identifiers in URLs:** fixture matching is `(method, path)` FIFO. Random per-test UUIDs that appear in URLs (`sessionId`, etc.) must be pinned to fixed strings in the test, otherwise the recorded path won't match the replay path. Body-only identifiers (labels, request payloads) can stay random — body comparison is intentionally loose.

## Integration Test Isolation

Each integration file gets its own state from `test/integration-setup-per-file.ts`, which runs before the file's modules load. Files sharing a worker run one after another, so anything scoped to the worker would carry one file's rows and recordings into the next.

| Per file | Set up by | Read it with |
|-|-|-|
| Database | `CREATE DATABASE … TEMPLATE` from the one `globalSetup` migrated, then seeded like a deployment (`test/integration-database.ts`) | `fileDatabaseUrl()`, which is also `DATABASE_URL` |
| Seeded user | that seed; the owner `bootstrap()` resolves, and the id of its Hindsight bank | `fileDefaultUserId()` |
| llmock | loads `suites/<file>/` (Cassettes above) | `fileLlmockUrl()` |
| Skills bare repo | a fresh directory under `inject("skillsRoot")`, since every `bootstrap()` initializes and registers the repo there | `COGMO_SKILLS_PATH` |

Per worker slot, `globalSetup` starts an Inngest dev server — a container, so one per slot rather than per file — and the per-file setup points the file at its slot's by `VITEST_POOL_ID`. Read it with `workerInngestBaseUrl()`. Every file shares one Hindsight (partitioned by bank, so by user), Redis, RustFS, the Docker daemon, and the MCP echo and Telegram mocks.

`process.env` mutations in Vitest `globalSetup` propagate to test workers (worker env = `{ ...process.env, ...config.env }`): container URLs and `COGMO_MASTER_KEY` are set there, per-file values by the per-file setup. Static values (`NODE_ENV`) go in `vitest.config.ts` `test.env`. Test files use normal top-level imports — `createEnv()` in `env.ts` sees all values.

## Telegram Testing

- **Unit:** grammY transformers + `handleUpdate()` for testing adapter logic without network. Current tests use `vi.mock("grammy")` — future enhancement to use grammY's built-in test primitives.
- **Integration:** Not tested — integration tier uses Direct adapter.
- **E2e (future):** Telegram Test DC + tgintegration (TypeScript/mtcute). Real user account on Telegram's test servers.
