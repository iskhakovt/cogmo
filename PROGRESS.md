# Progress

## Phase 0: Project Setup

- [x] Initialize Node.js project (`package.json`, `tsconfig.json`, Biome, Vitest)
- [x] Set up TypeScript build (tsx watch for dev, tsup for production)
- [x] Install core dependencies (Anthropic SDK, Drizzle, Zod v4, Pino, Remeda, neverthrow, ts-pattern, etc.)
- [x] Set up directory structure (`src/agent/`, `src/transport/`, `src/db/`, `src/inngest/`, `src/llm/`, `src/memory/`)
- [x] Docker infra via testcontainers (`scripts/dev-infra.ts`, `dev/containers.ts`)
- [x] Drizzle schema — 9 tables across two stores (`agent/store/`, `transport/store/`)
- [x] Generate Drizzle migration and verify against PostgreSQL
- [x] Set up Inngest — SDK installed, Docker container configured, events typed
- [x] End-to-end message pipeline — LLM abstraction, agentic loop, Inngest orchestration
- [x] Unit tests — 115 tests (31 PGlite store tests + 84 mocked tests)
- [x] Verify Hindsight connects to PostgreSQL + pgvector
- [x] Main entrypoint (`src/main.ts`) — `serve` and `seed` commands
- [x] Seed script (`src/seed.ts`) — idempotent database seeding for single-user deployment
- [x] Three-tier test structure — unit (PGlite), integration (Docker + in-process), e2e (Docker container)
- [x] CI pipeline — typecheck, lint, unit tests, integration tests, Docker-based e2e, Codecov coverage, JUnit test reports
- [x] Slim Hindsight image for tests — llmock fixture replay, no Ollama dependency
- [ ] Basic health check endpoint (HTTP)

## Phase 1: MVP — Conversation + Memory

The minimum useful system: talk to it, it remembers things.

- [x] Agentic loop as Inngest function — event-driven, durable steps per Claude call + tool execution
- [x] Typed LLM calls — `chatTyped()` with Zod schemas, `responseFormat`, `ThinkingBlock`, retry with feedback injection
- [x] Telegram adapter — grammY, long polling, DMs only, `AdapterModule` contract
- [x] Channel registry — table-driven adapter discovery via `AdapterModule` + `satisfies` barrel
- [x] Direct channel adapter — event-driven via Inngest (`adapter/direct/inbound`, `adapter/direct/outbound`)
- [x] Memory: Hindsight integration — `retain()`, `recall()`, `reflect()`
- [x] Memory: 4 networks (world, bank, opinion, observation) — tag-based classification (`network:world/bank/opinion/observation`), Observer extraction with `chatTyped()`, `retainBatch` with `observation_scopes: "per_tag"`
- [x] Memory: route intention gate — profile-level `auto_recall` setting (`off/always/heuristic/llm`), heuristic gate skips greetings/acks/continuations
- [x] `memory_recall` and `memory_retain` tools for the agent
- [x] Core memory blocks — DB table, `core_memory_update`/`core_memory_read` tools, injected into system prompt
- [x] Auto-recall — embed user message each turn, inject as `# Recalled Context` in system prompt
- [x] Post-conversation Observer — Inngest function triggered by `conversation/idle` event (Stage 1 evolution)
- [x] Instruction file (Stage 1 evolution) — correction extraction via chatTyped(), persisted to steeringRules with graduation + consolidation
- [x] Steering rules table in PostgreSQL — injected into system prompt per invocation
- [x] ~~Internal tag stripping~~ — removed; native thinking blocks + tool calls cover the use cases
- [x] Crash recovery — handled by Inngest durable steps (automatic resume from last checkpoint); summarization LLM call wrapped in `step.run`, replay test via `@inngest/test`, contract documented in `design/crash-recovery.md`
- [x] Session lifecycle — Inngest idle timer, resolveSession staleness, `/new` command, debounce wiring
- [x] Context window management — countTokens() on LlmProvider, model registry, three-layer compaction pipeline, pair-aware compaction
- [x] Full tool invocation history — messages.content stores ContentBlock[] (text, tool_use, tool_result, image, thinking), not just final text
- [x] Message batching — debounce-router, debounce-idle, debounce-maxwait with entry guards and resume policy
- [x] Response routing — source routing via DeliveryRouter, getSourceSessions + getReceiveAllSessions
- [x] Telegram auth — user ID allowlist via `user_identities` DB rows, enforced in adapter via `resolveUser`
- [x] System prompt assembly — auto-generated from tool registry + service guidance + conditional onboarding
- [x] Streaming responses — unified DeliveryRouter, StreamingAdapter/StreamHandle, TelegramStreamHandle
- [x] Web tools — web_search (Tavily), web_answer (Perplexity Sonar), fetch_url (readability + SSRF)
- [x] File tools — read_file/write_file/list_files via S3 (MinIO), Service.files namespace
- [x] Image support — ImageBlock type, Anthropic + OpenAI adapters, Telegram photo handler, AttachmentStore
- [x] OpenAI-compatible LLM adapter — covers OpenAI, xAI, OpenRouter via official SDK
- [x] Store pattern — `agent/store/` and `transport/store/` with interfaces + Drizzle implementations
- [x] Transport layer — `Adapter`, `Transport` interfaces, event-driven inbound pipeline (`inbound/arrived`, `response/ready`)
- [x] Unified delivery — `DeliveryRouter` replaces per-channel respond functions, handles streaming + batch
- [x] neverthrow at Transport boundary — `emit()` and `createConversation()` return `Result<T, TransportError>`
- [x] `#private` fields + `private constructor` + `static async create()` on all classes
- [x] Console script — `scripts/console.ts`, standalone readline + DB polling client
- [x] Encrypted secrets at rest — `secrets` table, AES-256-GCM via `@noble/ciphers`, HKDF key derivation via `@noble/hashes`, `_FILE` Docker secrets convention, `ConfigResolver` (DB-first env-fallback), `gen-key` CLI
- [x] Multi-provider LLM — `llm_providers` table, `model_providers` routing table (position-based priority), provider dispatch in bootstrap via model → provider resolution, Anthropic + OpenAI-compatible adapters
- [x] Channel management — `createIdentity`, `updateChannelCredentials`, `removeChannel` on transport store, identity resolution wired in `createConversation`
- [x] Seed refactor — `src/setup/seed.ts` with named exports, reusable by wizard and CLI
- [x] Guided setup wizard — `cogmo setup` via `@clack/prompts`, provider validation (`/v1/models`, `getMe`), Telegram channel + allowlist, re-runnable (Keep/Modify/Skip), `--reset` scopes, `--non-interactive` mode

## Phase 2: Scheduling + Ingestion

The agent does things on its own, not just when you talk to it.

- [ ] Morning briefing — Inngest cron function
- [ ] Post-conversation extraction — Inngest delayed function
- [ ] Memory consolidation — daily `reflect()` via Inngest cron
- [ ] Agent self-scheduling tools — `schedule_task`, `list_tasks`, `remove_task`
- [ ] Human-in-the-loop — Inngest `step.waitForEvent()` + Telegram callback buttons
- [ ] Dual-mode monitoring for ingestion — embedding scan first, LLM only when relevant
- [ ] First ingestion agent: Gmail (MCP)
- [ ] First ingestion agent: Google Calendar (MCP)
- [ ] Concurrency control — per-conversation FIFO, global concurrency limit via Inngest
- [ ] Claude Agent SDK integration — background tasks via subscription ($0)

## Phase 3: Skill Library + More Integrations

The agent extends its own capabilities.

- [ ] Skill library — `skills/code/` + `skills/description/`, Voyager pattern
- [ ] MCP dynamic tool registration — agent writes skill, registers as tool
- [ ] Human review gate for new skills — Inngest `step.waitForEvent()` + Telegram approval
- [ ] SKILL.md standard — progressive disclosure (tier 1/2/3)
- [ ] Permission tiers — read-only / read-write auto / read-write approval
- [ ] Additional integrations (as needed): Strava, banking, GitHub

## Phase 4: Prompt Optimization

The agent improves its own prompts.

- [ ] Evaluation rubrics — LLM-as-judge per task type
- [ ] Bootstrapped few-shot — collect passing traces as demos (~20 conversations)
- [ ] Textual feedback in metrics — return *why* a score was low
- [ ] Instruction candidate generation — 5-10 alternatives with tip randomization
- [ ] ACE playbook pattern — living document with delta edits (add/modify/remove)
- [ ] Signal capture table — session signals with reliability ratings

## Phase 5: Signal Pipeline + Evolutionary Search

- [ ] Full capture -> evaluate -> rewrite -> test -> deploy loop
- [ ] Anti-pattern enforcement — no instruction bloat, no contradictions
- [ ] Bounded code mutation with tree-structured archive (Stage 6)
- [ ] Lineage tracing for all evolution changes
- [ ] Sandbox execution for generated code

## Monitoring Thresholds (Scaling Triggers)

| Signal | Action |
|-|-|
| RAM pressure or swap | Move to larger host or optimise |
| API costs unsustainable | Evaluate local inference for background tasks |
| pgvector index > 1GB | Evaluate dedicated vector store |
| >50 skills | Hierarchical skill organization |
