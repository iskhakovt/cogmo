# Cogmo

Personal agent runtime — modular system with persistent memory and self-evolution.

## Glossary

| Term | Meaning |
|-|-|
| **Tool** | An LLM-callable function. Defined by name, description, and JSON Schema input. The LLM decides when to call it via `tool_use`. Implementation can be simple (return current time) or heavy (run a nested agent loop). See `ToolSpec` in `src/agent/tools.ts`. |
| **Agent** | An autonomous loop with its own system prompt, tool set, and model. Heavier than a simple tool — makes multiple LLM calls. Exposed to the orchestrator as a Tool (agents-as-tools pattern). The orchestrator doesn't distinguish agents from simple tools — both are `ToolSpec` entries. |
| **Service** | Scoped runtime dependencies injected into tool handlers by the orchestrator. The ACL boundary — tools access memory, http, etc. through this interface, never via direct service references. Scoped per conversation turn (userId, profile rules baked in). See `Service` in `src/agent/service.ts`. |
| **Channel** | A platform connection (Telegram, Direct, Slack). DB row with credentials and identity mode. Each channel type has an `AdapterModule` in `src/transport/adapters/`. |
| **Channel Session** | Maps a platform address to an active conversation (a Telegram DM, a Direct event address, a Web UI tab). Invisible to the agent — only the transport layer manages sessions. |
| **Conversation** | A dialogue thread with shared LLM context. No explicit lifecycle — just goes idle. |
| **Profile** | A named agent configuration: base prompt, model, enabled tools. Conversations use a profile. |
| **Orchestrator** | The `handle-message` Inngest function. Thin controller — resolves session, constructs scoped service, calls the agent loop, emits response events. Zero business logic. |
| **Control Command** | A channel command that doesn't go through the orchestrator (`/new`, `/profile`, `/settings`). Intercepted by the channel adapter, executed via domain services directly. Instant response, no LLM call. Distinct from regular messages which flow through the full pipeline. |
| **Steering Rules** | Dynamic behavioral rules stored as DB rows, injected into system prompts at invocation time. Can be global or scoped to a profile. Managed by evolution stages. |
| **Observer** | Post-conversation extraction. Runs after a conversation goes idle, extracts facts into Hindsight memory. |

## Design Doc Confidence Markers

Sections and decisions in `design/` docs carry a confidence marker:

| Marker | Meaning | How to act |
|-|-|-|
| `[confirmed]` | Validated and ready to implement. | Implement directly. Follow the spec. |
| `[proposed]` | Designed but not validated against real usage or best practices. | Research best practices before implementing. Challenge assumptions — the design may be wrong. Propose changes if research contradicts. |
| `[research]` | Captured from external research, not yet evaluated for this project. | Do not implement without evaluation. Check whether it applies to our constraints (single user, personal scale). Discuss with user before adopting. |

When a `[proposed]` or `[research]` item gets validated and implemented, upgrade its marker to `[confirmed]` in the doc.

## Architecture

Read `design/` for the full picture. Key docs:

| Doc | Contents |
|-|-|
| [overview.md](design/overview.md) | Vision, constraints |
| [architecture.md](design/architecture.md) | Topology, data flow, component map |
| [memory.md](design/memory.md) | Hindsight, 4 networks, Observer extraction, retrieval |
| [evolution.md](design/evolution.md) | 6-stage self-evolution ladder, safety patterns |
| [scheduling.md](design/scheduling.md) | Inngest, event-driven orchestration, job types, agent self-scheduling |
| [agents.md](design/agents.md) | Agentic loop, sub-agents, crash recovery |
| [crash-recovery.md](design/crash-recovery.md) | Durability map of `handle-message`, what re-executes on retry, test contract |
| [context-management.md](design/context-management.md) | Token counting, compaction pipeline, model registry |
| [transport/](design/transport/) | Messaging architecture — adapters, sessions, debounce, routing, identity |
| [integrations.md](design/integrations.md) | Channel adapters, skill library, permission tiers, plugin extensibility |
| [integrations/mcp.md](design/integrations/mcp.md) | MCP client — server config, lifecycle, sandboxing, schema pinning, profile filtering |
| [providers.md](design/providers.md) | Multi-provider LLM routing, `llm_providers` table, profile FK, provider dispatch |
| [image-generation.md](design/image-generation.md) | Image gen via Vercel AI SDK, fal.ai provider, outbound delivery, why AI SDK for images but not text LLMs |
| [sandbox.md](design/sandbox.md) | Container sandbox — sysbox-default runtime, Docker API proxy, lineage tracking, reaper |
| [skills.md](design/skills.md) | Skill execution — Python, two-tier runtime (Pyodide WASM + sysbox), warm pool, git-backed library |
| [coding-delegation.md](design/coding-delegation.md) | Claude Code / Codex CLI subprocess delegation, worktree + draft-PR flow, autonomy gates |
| [setup.md](design/setup.md) | Guided setup wizard UX contract — interactive flow, re-runnable behavior, non-interactive mode |
| [infrastructure.md](design/infrastructure.md) | Runtime requirements, Docker Compose, secrets (encrypted DB, master key, HKDF, `_FILE` convention), deployment |
| [data-model.md](design/data-model.md) | Table index — points to schemas in domain docs, deferred tables, design decisions |
| [testing.md](design/testing.md) | Local dev, unit/integration/LLM tests, mocking, evaluation dataset |
| [tooling.md](design/tooling.md) | Dev stack — runtime, build, ORM, testing, logging, linting, Kotlin-feel patterns |
| [decisions.md](design/decisions.md) | All decisions with rationale, eliminated options, adopted patterns |

## Custom Commands

- `/next` — pick up the next task from `todo.md`

## Task Tracking

`todo.md` has four sections:

| Section | Purpose |
|-|-|
| **Next** | Actionable now, priority-ordered. `/next` picks from top. |
| **Later** | Future-phase work. Promote to Next when the phase begins. |
| **Blocked** | Waiting on something external. Only the user moves these to Next. |
| **Done** | Completed. |

- **Priorities:** `p1` (do soon — core, unblocks work), `p2` (do eventually), `p3` (do if bored — polish, cleanup). Format: `` `p1` `` tag before the task text.
- Mark tasks `[x]` and move to Done when completed.
- When completing a task, also check off the corresponding item in PROGRESS.md and drop a fragment in [`changelog.d/`](changelog.d/). Filename: `YYYY-MM-DD-short-slug.md` — pick a slug specific enough that two parallel PRs the same day won't collide (use words from the actual change, not generic ones). Body is plain Markdown — the rich prose entry, no leading date or table syntax. Never edit existing fragments. One fragment per PR avoids merge conflicts on parallel PRs.

Other tracking docs:

| Doc | Purpose |
|-|-|
| [PROGRESS.md](PROGRESS.md) | Phased delivery plan — big picture |
| [changelog.d/](changelog.d/) | Significant changes log — one Markdown fragment per PR |

## Stack

- **Language:** TypeScript on Node.js
- **Framework:** None — raw Anthropic SDK + OpenAI SDK (for OpenAI-compatible providers)
- **Memory:** Hindsight (self-hosted server + HTTP client) — PostgreSQL + pgvector managed by Hindsight
- **Orchestration:** Inngest (self-hosted) — event-driven durable execution, scheduling, queues
- **Interface:** Telegram (primary), adapter pattern for others
- **Deployment:** Standard Node.js process (systemd, Docker, etc.)

## Module Structure

| Module | Responsibility | Rule |
|-|-|-|
| `src/agent/` | Agentic loop, tool registry, service interface, prompt assembly, tools (memory, web, file, core memory) | Domain logic — how the agent thinks and acts |
| `src/transport/` | Channel adapters (Direct, Telegram), delivery router, attachment store, session management, identity | Transport — how messages arrive and responses are delivered |
| `src/db/` | Connection pool, transaction helper | Pure infrastructure — no schemas, no business logic |
| `src/inngest/` | Inngest client, event definitions | Orchestration infrastructure — client setup and event schemas only, no business logic |
| `src/llm/` | LLM provider interface, SDK adapters (Anthropic, OpenAI-compatible), canonical types (ContentBlock, StreamEvent, ImageBlock) | Single LLM call — provider abstraction, request/response translation |
| `src/memory/` | Memory provider interface, Hindsight adapter | Memory access — provider abstraction, HTTP client |
| `src/util/` | Cross-cutting pure helpers (retry, etc.) | Stateless utilities only — no I/O ownership, no domain logic. If a helper needs DI, it belongs in a domain module instead. |

**Infrastructure modules (`db/`, `inngest/`, `llm/`, `memory/`) contain only core setup and abstractions.** Business logic that uses them lives in domain modules (`agent/`, `transport/`). Example: the Inngest event definitions live in `src/inngest/events.ts`, but the `handle-message` orchestrator function that uses them lives in `src/agent/`. Respond functions live in `src/transport/`, not `src/inngest/functions/`.

### Store Pattern

Each domain module owns its DB access in a `store/` subdirectory:

- **`<module>/store/schema.ts`** — Drizzle table definitions owned by this module
- **`<module>/store/index.ts`** — Store interface + implementation. All DB reads/writes go through this.
- **`src/db/schemas.ts`** — Barrel file re-exporting all module schemas (for drizzle-kit migrations only)

| Store | Tables |
|-|-|
| `agent/store/` | conversations, messages, steering_rules, profiles, core_memory_blocks |
| `transport/store/` | channels, channel_sessions, inbound_messages, user_identities |

**Interface boundary, not table boundary.** A store implementation can import schemas from any module — JOINs and cross-table transactions are fine. Consumers depend on the store interface and mock it in tests. The schema defines ownership (who creates/migrates the table); the interface defines access (who can read/write what).

**Constructors take a `Transactor`, not a `Database`.** Every Drizzle store implementation accepts `runInTx: Transactor` (`<T>(cb: (tx: Transaction) => Promise<T>) => Promise<T>`, exported from `src/db/index.ts`) and wraps each method body in `this.#runInTx(async (tx) => { ... })`. Wire stores at the bootstrap edge with `transactor(db)`. Stores never hold a `Database` field — that would let a future method slip in a non-transactional read. Tests get `tx` from `createTestDatabase()`'s `{ db, tx, close }` return, so PGlite-backed unit tests pass `tx` straight into store constructors.

## Commits & PRs

- **Conventional Commits** — all commit messages and PR titles must follow the [Conventional Commits](https://www.conventionalcommits.org/) spec. Format: `type(scope): description`. The description must start with a **lowercase letter** — commitlint's `subject-case` rule rejects sentence-case, even for proper nouns (write `telegram` not `Telegram`). This drives semantic-release — wrong format means no release. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full type→version-bump table, examples, and the CI/release workflow.
- **No force pushes** — always create new commits to address review feedback. Force pushes erase review context, break comment threading, and make it impossible to see what changed between rounds. Amending is only acceptable before the first push of a branch.
- **Merge over rebase** — use `git merge` to incorporate upstream changes, not `git rebase`. Merge preserves the original commit graph, keeps review comments attached to their commits, and avoids the force push that rebase requires.

## Code Style

- **Comments describe the current state, not migration history.** Don't write "Tighter than the previous `[0-9a-f-]{36}` regex which would accept...", "Replaced the unconditional UPDATE here", "Don't say 'Done' because we used to...". Future readers don't have the prior code in front of them — they want to know what this code IS and why, not what it ISN'T or what it replaced. The diff and commit message own the migration story; the comment owns the present-tense rationale. If a comment only makes sense by contrast with a prior version, delete it.
- **Idiomatic TypeScript** — use classes, interfaces, enums where they make the domain clear. Prefer `interface` over `type` for object shapes (extendable). Use generics for reusable components.
- **`function` declarations for named exports** — use `function foo()` not `const foo = () => {}`. Better stack traces, hoisted, readable. Arrow functions for callbacks and inline lambdas only.
- **Naming** — lowercase-hyphenated filenames (`steering-rules.ts`), `.test.ts` suffix for tests. PascalCase for classes/types/interfaces, camelCase for functions/variables.
- **Imports** — ESM with `.js` extensions (`import { foo } from "./bar.js"`). Named imports over default exports. Biome organises imports automatically. **No circular imports** — tsx/esbuild's `keepNames` helper breaks on circular ESM imports (`__name is not a function`). If A imports B and B imports A, restructure so one side accepts the dependency as a parameter instead.
- **Return types** — annotate exported functions that return domain types (`Transport`, `Service`, `AgentLoopResult`, etc.). Skip annotation when the return type is a complex library generic (Inngest functions, Drizzle columns) — inference is better there. Biome's `useExplicitType` nursery rule is too broad to enforce this; rely on review discipline.
- **Error handling** — `Result<T, E>` (neverthrow) at service boundaries and anywhere failure is expected. Exceptions only for programmer errors (bugs). Never `catch` and silently swallow.
- **No mutable state across boundaries** — functions may mutate local arrays/objects internally for performance, but must return defensive copies (spread or `structuredClone`). Never return a reference to internal mutable state — this is rep exposure. Use `Readonly<T>` / `ReadonlyArray<T>` in return types where practical.
- **Prefer libraries over bespoke code** — check if a well-maintained library solves the problem before writing a custom implementation. See `design/tooling.md` for the approved stack.
- **Use the stack** — Remeda for collection processing, neverthrow for Result types, ts-pattern for pattern matching, Zod for validation, Drizzle for queries. Don't reinvent what these provide.
- **Functional collection processing** — use `R.map`, `R.filter`, `R.pipe`, `R.reduce`, `R.groupBy`, etc. over `for` loops for data transforms. `for` loops are acceptable only when the body is side-effectful (sequential `await`, I/O) or is a stateful scan with early exit that would be less readable as a functional chain. If you reach for a `for` loop, first check whether `R.map`/`R.flatMap`/`R.reduce` can express it. Prefer Drizzle's `.values([...])` batch insert over looping inserts.
- **Inject dependencies, don't hard-import them** — services and stateful dependencies (db, LLM provider, agent loop) should be passed in as parameters — interface, class, or function. Hard-importing a concrete implementation creates coupling that requires `vi.mock()` to test. A function parameter counts as injection — `bar(chat: () => Promise<Response>)` is as good as `bar(provider: LlmProvider)`. Pure helpers, utilities, constants, type definitions, and schema objects (e.g. `eq()` from drizzle, `logger`, Zod schemas) are fine to import directly.
- **Strict encapsulation** — all class fields and methods must be `#private` unless declared on the interface the class implements. Use ES2022 `#` (runtime-enforced), not TypeScript `private` (erased at compile time). This prevents accidental exposure of implementation details and ensures the interface IS the public API.
- **Async class initialization** — use `private constructor` + `static async create()` factory. Never do async work in constructors. The factory ensures the instance is fully initialized before it's returned. Thin standalone factory functions can alias the static method (e.g., `const startFoo: StartAdapter = Foo.create`).
- **Avoid `as` type assertions** — `as` silences the type checker and hides bugs. Prefer: type guards (`if (x.type === "foo")`), Zod parsing, refactoring so the source produces the correct type, or Postgres enums (Drizzle `pgEnum` → TypeScript union, no cast needed). Acceptable uses: `as const` for literal narrowing; `as unknown as X` in tests for intentionally invalid input; Drizzle result casts when the select shape exactly matches the return type and inference falls short. If you write `as`, justify why the alternative is worse. **`as unknown` in production code requires an inline comment naming the specific library type gap it's working around** (e.g. "OpenAI SDK type doesn't include tool_calls on this message variant", "dockerode hijacked stream is structurally Writable but typed as Duplex"). No comment = the cast is hiding something instead of documenting it.
- **Generalise where reasonable** — extract interfaces and shared types when two or more consumers exist. Don't over-abstract for hypothetical future use.
- **No dead code** — if nothing consumes a method, delete it or make it private. No code "just in case".

## Testing

### Principles

- **One module per test file** — each `.test.ts` tests exactly one source module. Mock everything outside that module.
- **Design for testability** — accept interfaces, not concrete classes. Pass dependencies (db, provider) as parameters, not imports. If something is hard to test, the design is wrong — fix the design, not the test.
- **Test contracts, not internals** — test the interface a consumer depends on. If changing an implementation detail breaks a test, the test is too coupled. If a contract changes and no test breaks, there's a gap.
- **Boundary behavior matters** — defensive copies, error propagation, unknown/missing inputs, edge cases at module boundaries. This is where real bugs live.
- **Test helpers for readability** — factory functions (`mockProvider()`, `textResponse()`) keep tests scannable. Prefer building test data declaratively over inline object literals repeated across tests.
- **Mock interfaces with `mock<T>()` from `vitest-mock-extended`, not `as any`.** For any stub of a project-owned interface (`MemoryProvider`, `SecretsStore`, `SkillStore`, `Service`, etc.), use `mock<T>()` — it returns a typed `MockProxy<T>` with every method as a `vi.fn()`, no casts needed. Override individual methods with `.mockResolvedValue(...)` / `.mockImplementation(...)`. **Do not write** `{ partial fields } as any` to satisfy a typed dep. *Two known caveats:* (1) optional/nullable properties on the mocked type are auto-mocked too, so a test that asserts the property is `undefined` must explicitly assign `mock.foo = undefined` after construction — see `src/agent/coding/tool.test.ts`. (2) Stateful test fixtures with custom call-tracking (e.g. the dockerode stubs in `src/sandbox/supervisor.test.ts` / `reaper.test.ts`) and partial third-party types where only one method is exercised (`{ send } as any` for Inngest) stay as targeted partial casts — `mock<T>()` doesn't help when the value of the test IS the stateful tracking.
- **Coverage patterns** — `design/testing.md` → "Coverage Patterns" lists concrete recipes (JSONB raw-SQL bypass, discriminated-union parse tests, audit invariants, error-path matrix, resource-cleanup invariants, concurrency invariants, CLI exit-code matrix). Apply to new test code.
- **Framework:** Vitest. See `design/testing.md` for full details.

### Three-Tier Structure

| Tier | Infra | App | LLM | What it proves |
|-|-|-|-|-|
| **unit** `.test.ts` | PGlite (in-process) | mocked / direct | mocked | Module logic, store queries, contracts |
| **integration** `.integration.test.ts` | Docker (PG, Redis, Inngest, Hindsight) + llmock | in-process | llmock fixtures | Pipeline orchestration, memory round-trip, event routing |
| **e2e** `.e2e.test.ts` | Docker (full stack) + llmock | subprocess | llmock fixtures | Binary boots, migrations apply, full stack smoke |

Commands: `pnpm test` (unit), `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:all`.

### Store Tests with PGlite

Store implementations (`DrizzleAgentStore`, `DrizzleTransportStore`) are tested against real SQL via PGlite — an in-memory WASM PostgreSQL (PG17). No Docker needed.

- **Schema:** Applied via `pushSchema()` from `drizzle-kit/api` — no migration files in tests.
- **UUIDs:** `pg_uuidv7` PGlite extension + `uuidv7()` SQL alias (the extension exposes `uuid_generate_v7()`).
- **Type:** `Database` is `PgDatabase<PgQueryResultHKT, schema>` — driver-agnostic. Works with postgres-js, PGlite, or any Drizzle PG driver. No `as any` casts needed.
- **Cleanup:** Truncate all tables via `db.execute(sql\`...\`)` between tests. One PGlite instance per test file.
- **Helper:** `src/test/pglite.ts` — `createTestDatabase()` and `truncateAll()`.

### LLM Mocking with llmock

`@copilotkit/aimock` provides a deterministic mock LLM HTTP server. Single instance serves both Anthropic Messages API (`POST /v1/messages`) and OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/embeddings`) for Hindsight. Fixture-based routing, request journal for assertions. Replaces both `mock-anthropic` container and Ollama.

**Re-record when requests change.** When adding features that change what LLM or embedding requests are made during integration/e2e tests (new tools in the system prompt, auto-recall, different prompt structure), re-record fixtures via `pnpm test:record` before pushing. CI runs in strict mode — unmatched requests return 503.

### Integration Test Env Injection

`process.env` mutations in Vitest `globalSetup` propagate to test workers (worker env = `{ ...process.env, ...config.env }`). Dynamic values (container URLs, `COGMO_MASTER_KEY`) are set via `process.env` in globalSetup. Static values (`NODE_ENV`) go in `vitest.config.ts` `test.env`. Test files use normal top-level imports — `createEnv()` in `env.ts` sees all values.

### Telegram Testing

- **Unit:** grammY transformers + `handleUpdate()` for testing adapter logic without network. Current tests use `vi.mock("grammy")` — future enhancement to use grammY's built-in test primitives.
- **Integration:** Not tested — integration tier uses Direct adapter.
- **E2e (future):** Telegram Test DC + tgintegration (TypeScript/mtcute). Real user account on Telegram's test servers.

## Working with Tools

- **IMPORTANT: Research the documented approach first.** Before implementing anything that involves infrastructure, library integration, testing patterns, or deployment — search for the official docs and best practices. The documented approach is almost always better than a workaround. This has been validated repeatedly: Docker Compose profiles, Inngest connect mode for testing, testcontainers patterns. Don't debug symptoms when the root cause is "we're not using the tool the way it was designed." If you catch yourself iterating through trial-and-error, stop and google.
- **Check versions** — before adding a dependency, check the latest version on the registry and read the official setup/migration guide. Don't assume versions or config from memory — they go stale and may not exist. Verify the specific version you pin actually exists upstream before committing. Check both the latest release and the latest LTS; if they differ, ask the user which to use.
- **Verify runtime compatibility** — when a pinned tool has runtime requirements (engine fields, etc.), check that the execution environment provides what it needs. Don't assume CI runners, dev machines, or base images have a compatible runtime by default.
- **Review existing tools** — before committing to a bespoke implementation, check if a maintained library or built-in feature covers the use case. Prefer battle-tested solutions.

## Autonomy

- Adding/updating dev dependencies, editing existing files, running tests — go ahead.
- Adding a new **runtime dependency** — discuss first (affects deployment size and RAM).
- Changing architecture patterns or data model — discuss first.
- **Scope the domain before implementing.** Walk through real use cases and challenge every abstraction before writing code. Ask: what are the entities, how do they relate, what changes independently? If two things evolve at different rates or serve different consumers, they're separate concerns — don't merge them because they happen to be available together. E.g.: "what the user said" and "how it was delivered" feel like one thing at arrival time, but one is conversation history and the other is transport — different lifecycles, different consumers, different tables.

## Verification

After making changes, run: `pnpm typecheck && pnpm lint && pnpm test`

**Bug fixes: verify-then-act.** Prove the symptom (failing test or repro steps), identify root cause, propose fix, write a regression test. No shotgun debugging.

## Design Philosophy

- **Build for the long term, not just the next feature.** This is not an MVP hack — it's a system designed to grow. Before implementing, think about how each piece interacts with the rest: how will this work with memory extraction? With multi-channel? With evolution? If a shortcut now creates a rewrite later, take the longer path. Stop and think about how pieces fit together before writing code.
- **Early abstractions pay off** — define interfaces and typed contracts upfront. A clean LLM provider interface costs nothing now and saves a rewrite later.
- **Event decoupling** — components communicate via Inngest events, not direct imports. The orchestrator emits `response/ready`; channel adapters listen independently. Adding a new channel never touches the orchestrator.
- **Thin infrastructure layers** — Inngest functions are controllers: receive event, call domain services, emit events. Zero business logic in `src/inngest/functions/`. Domain logic lives in `src/agent/`, `src/llm/`, `src/transport/` and is testable without Inngest.
- **Domain owns logic, infra owns wiring** — if swapping Inngest for something else, only `src/inngest/` changes. If swapping Anthropic for OpenAI, only `src/llm/anthropic.ts` changes.
- **Design for pluggability** — prompts, tools, LLM providers, and channels each have an explicit interface (`LlmProvider`, `Service`, `Adapter`, `Transport`, etc.) that defines the plugin contract. All code depends on these interfaces, never on concrete implementations. Today they're in-process; in the future they become the boundary for external plugins (WASM, MCP, containers). Every new extension point must define its interface first. See `design/integrations.md`.
- **Service interface for tools** — tools access external systems exclusively through `Service`, never via direct service references. The orchestrator scopes the service per request (e.g., memory scoped to the current user's bank) and controls what each tool can access (ACL boundary). This is the same interface whether tools run in-process or in WASM. Tool inputs are validated at runtime — Zod for in-process TypeScript tools, JSON Schema validator for future plugins. See `design/agents.md` → Tool Architecture.

## Architecture Rules

- No frameworks — raw SDK only.
- **All DB operations use transactions.** Stores enforce this at the type level — they take a `Transactor` (`runInTx: <T>(cb: (tx: Transaction) => Promise<T>) => Promise<T>`, see `src/db/index.ts`) and wrap each method body in `this.#runInTx(async (tx) => { ... })`. Outside store implementations (e.g. ad-hoc bootstrap code, scripts) the same rule applies: `db.transaction(async (tx) => { ... })`.
- **Every table gets a UUIDv7 primary key (`id`, DB-generated) and `created_at TIMESTAMPTZ DEFAULT now()`.** No exceptions.
- **Columns are NOT NULL unless explicitly nullable.** Drizzle defaults to nullable — always add `.notNull()`. Nullable columns must be justified (e.g., `expires_at` = never expires, `steering_rules.profile_id` = null means applies to all profiles, `steering_rules.channel_type` = null means applies to all channels).
- **Avoid default values** in DB columns and function parameters unless strongly justified (`id`, `created_at` are justified). Explicit values at the call site prevent hidden assumptions.
- **Use `pgEnum` for any column whose values we control.** Don't use `text` + CHECK constraint for closed value sets — Drizzle's `pgEnum` produces a real Postgres `CREATE TYPE`, gives the TS column a literal-union type without `as` casts, and rejects unknown values at write time. Reserve `text` for values from external systems (channel types from third-party adapters, model names from upstream providers) where the set isn't ours to define. Reference: `auto_recall_mode`, `conversation_status`, `pending_memory_source` in `src/agent/store/schema.ts`.
- **No table design is final.** Schemas in `design/` docs are design intent, not frozen specs — they evolve as real usage reveals issues. When changing a table, update both the Drizzle schema (`<module>/store/schema.ts`) and the design doc that owns it simultaneously.
- **Prefer immutable rows.** Insert once, avoid updates where practical. When updates are necessary (e.g. status transitions), that's fine — just design tables so most rows are append-only.
- **Every JSONB column has a Zod schema validated at the store boundary** (on both read and write). JSONB without a schema is rep exposure — any shape drift is caught where the bytes enter or leave the DB, not deep inside consumer code. Declare columns with the `jsonbZod(name, Schema)` helper from `src/db/helpers.ts` — a Drizzle `customType` wrapper that runs `Schema.parse()` in `toDriver` and `fromDriver`, so validation is built into the column instead of repeated at every call site, and Drizzle infers the row type as `z.infer<typeof Schema>` (no `JsonValue` casts). Name the schema in the design doc next to the column (e.g. `resource_usage JSONB, -- ResourceUsageSchema`). Reference: `messages.content` declared via `jsonbZod("content", MessageContentSchema)` in `src/agent/store/schema.ts`. Exception: opaque payloads that Cogmo never inspects (e.g. `channels.credentials`, which is encrypted ciphertext the adapter hands back to the channel SDK). Keep those as plain `jsonb()` and mark them OPAQUE in the schema comment.
- **Group atomic multi-field state in a JSONB blob, not separate columns.** When two or more fields are conceptually inseparable (set together, used together, never independently meaningful), prefer one nullable JSONB column with a Zod schema enforcing the all-or-none invariant over multiple nullable columns. Consumers do one null check; the schema makes "half-set" states unrepresentable at the store boundary. Reference: `coding_tasks.worktree_assignment` carries `{ branch, worktreePath }` — null until the orchestrator's allocate-worktree step runs, both fields populated together once it does. Single-field state stays as its natural type (text, timestamp, FK) — a JSONB blob with one field is just text-with-overhead. The trade-off is ad-hoc DB queries (`SELECT col->>'field'` instead of `SELECT field`) and indexability — accept that cost when atomicity matters more than DB-level access ergonomics, which is most of the time for lifecycle state.
- Memory writes are always additive. Dedup runs async via `reflect()`.
- Sub-agents never see API keys. Orchestrator makes all external calls.
- Every LLM call uses typed contracts (Zod schema in, Zod schema out) with retry + feedback injection.
- Self-evolution changes are gated: steering rule corrections auto-apply (graduation model), code/skill changes require human approval.
- Secrets never in env files or git. Use host secret management in production.
