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
| Store implementations | Drizzle queries against real SQL | PGlite (in-process PG18 WASM), `pushSchema` from `drizzle-kit/api` |
| Typed LLM calls | Zod schema validation, retry logic | Mock the SDK client, inject known responses |
| Adapter modules | Setup, deliver, inbound handling | Mock Transport, use shared test factories |
| Prompt assembly | System prompt + rules + memories | Mock AgentStore |
| Transport | Session resolution, emit, conversation creation | Mock stores |
| Respond | Message loading, session filtering, delivery | Mock stores + adapter |

Shared test factories in `src/test/factories.ts` — `mockAgentStore()`, `mockTransportStore()`, `mockTransport()`, `mockAdapter()`, `mockStep()`, etc.

**Mock lifecycle:** `clearMocks` is on — Vitest 5's default, which `vitest.config.ts` inherits rather than declares. Vitest calls `.mockClear()` on every spy before each test. Call history (`mock.calls`, `mock.results`, `mock.instances`) resets; implementations and queued `*Once` values set outside the test do not. So a `beforeAll` that installs a `mockResolvedValue` keeps working, while an assertion that counts calls accumulated by an earlier test in the same file will not — count within the test that makes the calls. Dropping an implementation still needs an explicit `mockReset()`, and un-installing a `vi.spyOn` needs `mockRestore()` — `restoreMocks` is off.

Nothing in the suite leans on the auto-clear today — it passes in full with `clearMocks: false`, because tests count calls within the test that makes them, as above. That is the point of the discipline: a Vitest major that flips the default would surface only in tests that broke the rule, which is why the setting is inherited rather than pinned in `vitest.config.ts`.

**PGlite setup:** `src/test/pglite.ts` — `createTestDatabase()` boots PGlite (PG18, so the schema's `uuidv7()` PK default resolves against core), applies schema via `pushSchema`, returns driver-agnostic `Database` type. `truncateAll()` clears tables between tests.

**Naming:** `.test.ts` suffix. `pnpm test`.

## Integration Tests `[confirmed]`

Docker services + app wired in-process. Tests the orchestration pipeline — debuggable, injectable, faster than e2e.

**Infrastructure:**
- Testcontainers started in vitest `globalSetup` (`test/integration-setup.ts`), random ports: PostgreSQL, Redis, RustFS, Hindsight (slim), and one Inngest dev server per worker slot
- Every container definition lives in `dev/containers.ts`, shared with `scripts/dev-infra.ts` for local dev — including those a single test starts itself (`gitea()`, `inngestKeyed()`). The `no-inline-test-container` lint rule keeps them there.
- llmock (`@copilotkit/aimock`) runs in-process: one per test file for the app's calls, replaying that file's cassette, and one in `globalSetup` for Hindsight's
- Hindsight reaches its llmock via `host.testcontainers.internal`, published by `exposeHostPort()` in `dev/containers.ts` — not `host-gateway`, which points into the wrong namespace under rootless Docker
- Each test file runs against its own database, cloned from a template `globalSetup` migrates, and its own seeded user — so its own Hindsight bank
- App modules imported directly — `bootstrap()` from `src/index.ts` wires everything

**Isolation:** `test/integration-setup-per-file.ts` gives each file its own database, seeded user (so its own Hindsight bank), llmock and skills repo, and points it at its worker slot's Inngest dev server — one per slot, so one fork's events never run in another. Hindsight, Redis, RustFS, the Docker daemon and the MCP echo and Telegram mocks stay shared. `.agents/rules/testing.md` → Integration Test Isolation and Cassettes has the detail, the unmatched-request and unused-recording checks included.

**Env injection:** `process.env` mutations in `globalSetup` propagate to Vitest test workers. Dynamic container URLs set via `process.env`, per-file values by the per-file setup, static values in `vitest.config.ts` `test.env`. Test files use normal top-level imports — `createEnv()` in `env.ts` sees all values.

**Naming:** `.integration.test.ts` suffix. `pnpm test:integration`.

| Test | What |
|-|-|
| Pipeline | `bootstrap()` in-process, emit `inbound/arrived` → assert assistant message in DB |
| Hindsight round-trip | `retain()` → `recall()` returns the fact (llmock provides instant deterministic responses) |
| Learning loop | Three conversations through `handle-message` and the Observer → the third turn's request, read from llmock's journal, carries the core-memory block, the rule the first two graduated, and a fact recalled from Hindsight |

## E2E Tests `[confirmed]`

Full deployment-like stack — cogmo runs from its release image, in connect mode. Smoke test.

**Infrastructure:**
- Testcontainers (PostgreSQL, Redis, Inngest, Hindsight, RustFS) — started in vitest `globalSetup`
- llmock in-process — replaces both mock-anthropic container and Ollama
- App image: `E2E_IMAGE` when set, which is how CI hands over the tag its bake step
  produced; otherwise `globalSetup` runs `docker buildx bake --load cogmo-e2e`, the same
  bake file CI builds from. That target is `cogmo` minus the GHA cache, pinned to
  `BAKE_LOCAL_PLATFORM` because `--load` imports one platform per tag. Needs the docker
  CLI with buildx. The image stays after the run, so a repeat run can skip the rebuild
  with `E2E_IMAGE=cogmo-e2e`
- Seed and app both run as containers off that image — `withCommand(["seed"])`, then
  `withCommand(["serve"])` in connect mode (WebSocket to the Inngest dev server)

**Naming:** `.e2e.test.ts` suffix. `pnpm test:e2e`.

| Test | What |
|-|-|
| Migrations | The app container applies migrations on boot. Verify tables queryable. |
| Smoke | Emit one event via Inngest API -> assert assistant response in DB |
| Skills | `cogmo skills register`, then `cogmo skills run` in a second process, for a tier-1 skill in the app container -> the bundled host spawns its Pyodide worker |

## Live Tests `[confirmed]`

Real provider APIs, for behaviour a replayed fixture can't show — recorded fixtures carry content, not usage, so replay can't prove a provider actually served a request from its prompt cache.

**Naming:** `.live.test.ts` suffix, the `live` Vitest project. `pnpm test:live`.

- Skipped unless `LIVE=1` and the provider's API key is set; never runs on PRs. The `live` project doesn't load `.env` itself, so export the root `.env` from the repository root and run the tier: `set -a; . ./.env; set +a; LIVE=1 pnpm test:live`.
- The prompt-caching live tests send requests through the wire recorder (`src/test/wire-recorder.ts`), which captures each request body and the provider's usage block, and assert on usage, since model output varies.
- Each run costs real money — keep prompts small and requests few. See `design/prompt-caching.md` → Test Plan → Live tier for the caching scenarios.
- **Evals** measure model behaviour against a labelled fixture set under `test/fixtures/evals/` and report per-case results and summary rates rather than asserting thresholds: one sample per case on a non-deterministic model makes a threshold either too loose to catch a regression or flaky. They fail only when a turn doesn't complete, and the doc that owns the behaviour records the numbers. `core-memory-routing.live.test.ts` and `core-memory-multiturn.live.test.ts` report to [memory.md](memory.md) → Core Memory vs Hindsight, `correction-learning.live.test.ts` to [evolution.md](evolution.md) → Stage 1. They share `src/test/live-eval.ts`, which runs the production prompt, tools and agent loop with core memory held in process and every other tool handler stubbed. The routing and multi-turn evals run with no steering rules; the correction eval seeds the Telegram channel rules its conversations would carry. `EVAL_REPEATS=N` samples every case N times; each case reports its pass count, and each summary row its rate over all samples followed by each run's own rate. A sample that throws or degrades counts against a `completed` row and is left out of the others. The deterministic checks and the rate summary live in `src/test/eval-checks.ts`, unit-tested. Their cases are written by hand; [Evaluation Dataset](#evaluation-dataset-research) is a planned held-out set to build from real conversations.

## Skill-Authoring Integration `[confirmed]`

`src/test/skill-authoring.integration.test.ts` drives chat -> `delegate_coding` -> auto-register -> skill invoke against `DaytonaMock`, llmock and a git remote. It proves that a user asking for a skill in chat gets a tool the agent calls on the next turn.

**Why this tier.** The other tiers stop short of the composed seam. `claude-cli-daytona.integration.test.ts` is manual (`describe.skip`) and covers only `plan`; `daytona-conformance.integration.test.ts` stops at the SDK and wrapper wire surface; `pipeline.integration.test.ts` doesn't exercise coding delegation; `skills.e2e.test.ts` registers and runs a tier-1 skill through the CLI. This suite composes PTY stream parsing, the snapshot lookup, the coding task from plan to PR, auto-register and skill-tool registration.

**Scenario.**

1. Turn 1 asks for `btc-spot`: fetch the CoinGecko BTC/USD price with `ctx.http.get`, return `{ price }`. The prompt forbids third-party HTTP libraries, declared dependencies and a `requirements.lock`.
2. The agent calls `delegate_coding` against the auto-registered `skills` repo. The profile's `codingAutoapproveMode` is `on`, so the plan gate clears without a human tap.
3. The task runs in a Daytona sandbox on `cogmo-devbase:<v>` through `DaytonaMock`: plan and execute drive the in-sandbox `claude` CLI over the production PTY path, then verify, push and PR open. The task ends `pr_open`.
4. `coding/task/pr-opened` triggers `coding-auto-register-skill`, which fetches the PR head branch into the bare skills repo and registers it. The skill is stdlib-only `tier: wasm`, so register compiles no lockfile.
5. Turn 2 ("What's bitcoin at?") lists the `btc-spot` tool and calls it; the skill runs in the tier-1 Pyodide worker.
6. The reply goes out as `adapter/direct/outbound`.

**What's asserted vs what's input noise.** The LLM is input noise; assertions pin the deterministic contract.

| Assert (deterministic) | Don't assert (model-drift bait) |
|-|-|
| Coding task reaches `pr_open` | Plan and `SKILL.md` wording |
| A `skills` row named `btc-spot` exists | Tool arguments the model chose |
| The skill's newest finished `skill_runs` row has `status: "success"` and `output.price` equal to the stand-in network's figure | Number of edits the CLI makes |
| An `adapter/direct/outbound` event to the session carries a price-shaped number | Exact reply text, wall-clock duration |

**Skill network.** The authored skill's `ctx.http` call is answered in-process by a stand-in network: a resolver and a `fetch` passed through `BootstrapOptions.skillCtxHttpOverride`, serving the one CoinGecko endpoint the skill calls. It applies in record mode as well as replay. The cassettes cover the chat and the sandbox, not the skill's own request, so without it the suite would depend on a public API's uptime and rate limits and fail offline. The allowlist and address checks still run against what the stand-in answers, since the override replaces the network, not the policy. A loopback stub server is not an alternative. A manifest can list `127.0.0.1` in `network.allow`, but the resolved-address check refuses loopback, so reaching a local server would take an injected resolver that misreports its address. That goes around the guard instead of through it. For the same reason the override takes both halves or neither: a resolver alone would pass the guard on its own answer while the global `fetch` connects wherever the name really points.

**Git remote.** Record mode pushes to the throwaway GitHub repo `COGMO_TEST_SKILLS_REMOTE` names, with the PAT from `gh auth token`. It resets that repo's `main` to an empty commit first and afterwards closes the PR and deletes the test branches and `refs/cogmo-wip/` refs. Replay uses a local bare `file://` remote and a stub Octokit. Its `POST /pulls` commits `test/fixtures/skill-authoring-branch/` onto the PR's head branch in the bare remote, standing in for the sandbox push the cassette swallows, so the verify fetch-back and the register fetch run their production path. It accepts the run-branch `DELETE` and throws on any other call.

**Fixtures.** `RECORD=1` writes the Daytona cassette and the llmock misses; the branch fixture is copied by hand from the recorded PR's head branch:

| Fixture | What | Re-record trigger |
|-|-|-|
| `test/fixtures/daytona/skill-authoring.json` | Daytona HTTP + WS: snapshot lookup, sandbox create and delete, file upload, git clone, exec sessions, and the PTY frames carrying the in-sandbox CLI's stream-json (`claude-haiku-4-5-20251001`, thinking off) | New `cogmo-devbase:<v>`, `@daytona/sdk` bump, coding prompt or CLI flag change |
| `test/fixtures/recorded/suites/skill-authoring/` | Anthropic `/v1/messages` for the host agent loop's two turns | Agent prompt change, model swap, tool registry change |
| `test/fixtures/skill-authoring-branch/` | The `SKILL.md` and `skill.py` the recorded sandbox pushed | Any Daytona cassette refresh |

The suite skips unless the Daytona cassette exists or `RECORD=1` runs with `DAYTONA_API_KEY`, `ANTHROPIC_API_KEY` and `COGMO_TEST_SKILLS_REMOTE` set. A record run also needs a `COGMO_DEVBASE_IMAGE` with a non-`latest` tag and an authenticated `gh`; without them it fails in setup. It builds the devbase snapshot from the bake target and waits for the deps-cache volume before the run; the test file's header has the steps.

**Cost and cadence.** Replay costs nothing and runs in the integration tier on every PR that changes code. A record run costs ~$1-2 of Daytona compute and Anthropic tokens; it runs locally and the operator commits the refreshed fixtures.

**Non-goals.**

- Not a regression test for the `claude` CLI. In replay its output is the cassette, so a change in the CLI shows only when a re-record breaks the orchestrator's contract with it.
- Not a perf benchmark. No duration threshold.
- One stdlib-only skill. The deps path is not composed here: `runner.sysbox.integration.test.ts` covers a tier-2 skill populating its venv from a lockfile.

## Coverage Patterns `[confirmed]`

Concrete test recipes that should be applied alongside the tier guidance above. Distilled from the audit of Phase 6 P1 PRs (#76 / #78 / #80 / #86), shipped 2026-04-30.

### JSONB raw-SQL bypass tests

Every JSONB column has a Zod schema enforced at the store boundary on **both** read and write (AGENTS.md → Architecture Rules). Tests must exercise both directions — write-side via `insertX({ malformed })` is the easy half; read-side requires bypassing the writer:

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
- **Constraint collisions** — UNIQUE / FK violations surface as the right `Err` (e.g. `uq_profiles_user_name` as `profile_name_taken`), and leave the caller's transaction usable.

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
- Every `ctx.*` skill RPC produces a `skill_context_calls` audit row with method + target.

These belong in **integration tests** that exercise the orchestrator + event bus + audit table together, not in module-isolated unit tests.

### CLI exit-code matrices

For every command surface (Telegram `/repo`, agent tools), enumerate the discriminated error codes and pin the user-visible response per code. Prevents drift where a new error code returns a generic fallback instead of a tailored message.

Reference: `src/transport/adapters/telegram/commands/repo.test.ts`; `src/agent/coding/tool.test.ts`.

### Version-pinning canaries

Runtime deps with breaking-change history (octokit, dockerode, sysbox image tags, Claude CLI flag set) deserve explicit tests that the API surface our code uses still exists. Today a runtime regression only surfaces in integration tests; a unit-tier schema validation against the SDK's request/response types catches it earlier.

(Currently aspirational — listed in progress.md → Phase 6 → Test infrastructure as a future canary.)

### Non-settling-promise regression guards

When a unit test exercises a path whose contract is "this Promise must reject within N ms" (timeouts, watchdogs, deadline-bounded waits), the mock has to model the *absence* of a resolution — a Promise that never settles — not just an immediate rejection. Tests using `await unboundedPromise` rely on vitest's per-test default timeout to fail, which (a) looks like an unrelated flake in CI, (b) doesn't pin the contract the timeout exists to enforce, and (c) often hides the bug because the timeout fires *after* the test reports green via some side effect.

The pattern:

```typescript
// WRONG — silent hang if `wait()` never settles, looks like an unrelated flake
await handle.wait();
expect(...).toBe(...);

// RIGHT — structurally bounded, asserts on the failure the rejection carries
const err = await handle.wait().catch((e: Error) => e);
expect(err).toMatchObject({ failure: { kind: "timed_out", deadline: "total" } });
```

Reference: `src/sandbox/daytona/exec-streaming.test.ts → "timeoutMs: total wall-clock cap fires…"`. Motivating incident: the 4-day Daytona WS-wedge ([changelog 2026-05-18](../changelog.d/2026-05-18-coding-exec-wedge-resilience.md)) had no unit-tier regression test because earlier tests modelled `wait()` as always-settling.

### Concurrency invariants

For in-process pub/sub (`CodingStreamingRegistry`, `EventEmitter` wrappers): pin listener-set snapshot semantics (subscribers added mid-emit don't fire for the in-flight event), a release during delivery (the event that ends a stream still reaches every subscriber), re-entrant publish, and burst ordering across multiple subscribers. Catches refactors that introduce async dispatch or live-iteration regressions.

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
| Anthropic API | llmock — fixture-based HTTP server, supports streaming + tool_use; the test file's own instance |
| OpenAI-compatible (Hindsight) | llmock — `globalSetup`'s instance, the one the container reaches |
| MCP servers | Stub MCP client with fixed tool results |
| Telegram | grammY `vi.mock` (unit), Test DC + tgintegration (e2e, future) |
| Gmail/Calendar | Record real responses, replay in tests |

## Evaluation Dataset `[research]`

Build incrementally from real conversations (Phase 4 prerequisite):

1. After ~20 conversations: extract passing traces as few-shot examples
2. After ~50 conversations: label a held-out set for automated evaluation
3. Score new prompt variants against held-out set before promoting

Store in `evaluation/` directory: `evaluation/traces/`, `evaluation/rubrics/`, `evaluation/held-out/`.
