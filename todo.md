# Todo

## Next

- [ ] `p2` Post-conversation Observer — Inngest function triggered by `conversation/idle` event
- [ ] `p2` Instruction file (Stage 1 evolution) — corrections append to JSON, loaded into system prompt
- [ ] `p2` Context fast path — account for output tokens in `shouldSkipCounting` (currently only tracks `inputTokens`, underestimates by one response worth)
- [ ] `p2` Background compaction — run summarization after response (while user reads) instead of before next turn, store pre-computed summary to eliminate compaction latency
- [ ] `p2` Internal tag stripping — `<internal>` tags visible to orchestrator, stripped before user
- [ ] `p2` Batch API support for async evolution tasks — 50% cost reduction for reflection, extraction, optimization
- [ ] `p2` Define InboundContent schema (Zod) — structured message content type instead of raw JsonValue everywhere
- [ ] `p2` CLI channel management commands — `main.ts channel add telegram --token=...`, `channel list`, `channel remove`
- [ ] `p2` Pass transaction function to stores instead of full Database — makes transactions inescapable, narrows the interface
- [ ] `p3` Consider dropping Inngest serve mode — only connect mode is used (tests, production, local dev)
- [ ] `p3` Upgrade Hindsight to v0.5.0 — 3-phase retain pipeline, new consolidation prompts. Re-record llmock fixtures after upgrade.
- [ ] `p3` Stale llmock fixture cleanup — detect unused fixtures after test run, auto-delete
- [ ] `p3` Telegram response formatting — HTML or MarkdownV2 with escape function
- [ ] `p3` Interactive bootstrap — guided setup for new deployments (choose channels, configure credentials)
- [ ] `p3` Basic health check endpoint (HTTP)
- [ ] `p3` grammY native test primitives — use `bot.handleUpdate()` + `bot.api.config.use(transformer)` instead of `vi.mock("grammy")`
- [ ] `p3` Telegram e2e via Test DC + tgintegration — real user on Telegram test servers, TypeScript/mtcute client
- [ ] `p3` Consider web interface adapter for e2e testing
- [ ] `p3` Evaluate DI library (ditox/awilix) when adapter count exceeds 5
- [ ] `p3` fetch_url SSRF hardening — dns.resolve() + IP check before fetch (current check is string-level only)
- [ ] `p3` Verify Perplexity Sonar citations structure via real OpenRouter API response — may need to adjust parsing

## Later

- [ ] `p2` Morning briefing — Inngest cron function (Phase 2)
- [ ] `p2` Post-conversation extraction — Inngest delayed function (Phase 2)
- [ ] `p2` Memory consolidation — daily `reflect()` via Inngest cron (Phase 2)
- [ ] `p2` Agent self-scheduling tools (Phase 2)
- [ ] `p2` Claude Agent SDK integration — background tasks via subscription (Phase 2)
- [ ] `p2` First ingestion agent: Gmail via MCP (Phase 2)
- [ ] `p2` First ingestion agent: Google Calendar via MCP (Phase 2)
- [ ] `p3` Artifact renderer — standalone web server for rich content (charts, tables, interactive views)
- [ ] `p3` Skill library — Voyager pattern (Phase 3)
- [ ] `p3` MCP dynamic tool registration (Phase 3)
- [ ] `p3` Prompt optimization — evaluation rubrics, bootstrapped few-shot (Phase 4)

## Blocked

## Done

- [x] Typed LLM calls — `chatTyped()` with Zod schemas, `responseFormat` on ChatParams, `ThinkingBlock` + extended thinking, `clearOldThinking` pre-pass, retry with feedback injection
- [x] Response routing — source routing per `design/transport/response-routing.md`
- [x] Initialize Node.js project (package.json, tsconfig, Biome, Vitest)
- [x] Set up TypeScript build (tsx watch, tsup production)
- [x] Install core dependencies
- [x] Set up directory structure
- [x] Docker infra via testcontainers (`scripts/dev-infra.ts`, `test/containers.ts`)
- [x] Drizzle schema — module store pattern (`agent/store/`, `transport/store/`)
- [x] Design doc confidence markers (`[confirmed]`/`[proposed]`/`[research]`)
- [x] Decide orchestration: Inngest over BullMQ (event-driven durable execution)
- [x] End-to-end message pipeline — LLM abstraction, agentic loop, Inngest orchestration
- [x] Unit tests — 84 tests across 14 files
- [x] Initial Drizzle migration — 9 tables (users, profiles, conversations, messages, steering_rules, channels, channel_sessions, inbound_messages, user_identities)
- [x] CLAUDE.md — design philosophy, testing rules, DI stance, code style, encapsulation rules
- [x] Tool system refactor — Service interface (ACL boundary), Zod validation, defineTool helper
- [x] `memory_recall` and `memory_retain` tools with Service integration
- [x] Hindsight wired into orchestrator via Service
- [x] Hindsight retain/recall round-trip verified — integration test with Ollama via testcontainers
- [x] Telegram adapter — grammY, long polling, Transport interface, AdapterModule contract
- [x] Telegram auth — user ID allowlist via env var
- [x] Structural alignment — renamed `channels/` → `transport/`, store pattern, new events (`inbound/arrived`, `response/ready`), Adapter/Transport interfaces
- [x] Direct channel adapter — event-driven via Inngest, replaces old CLI adapter
- [x] Channel registry — table-driven adapter discovery via `AdapterModule` + `satisfies` barrel
- [x] Shared respond factory — `createRespond()`, generic per-channel respond in registry
- [x] Shared test factories — `src/test/factories.ts`, all test files use shared mocks
- [x] Transport tests — `transport.test.ts` covering resolveSession, createConversation, emit
- [x] neverthrow at Transport boundary — `emit()` and `createConversation()` return `Result<T, TransportError>`
- [x] `#private` fields on all classes — ES2022 runtime enforcement
- [x] `private constructor` + `static async create()` — TelegramAdapter
- [x] CLI entrypoint — `src/cli.ts` with `serve`/`seed` commands, Dockerfile ENTRYPOINT
- [x] Seed script — `src/seed.ts`, extracted from `ensureDefaults()`, idempotent
- [x] `contentToText()` helper — centralized JsonValue → string conversion
- [x] Console script — `scripts/console.ts`, standalone readline + DB polling
- [x] Replace `pg` driver with `postgres.js` — pure JS, faster, zero API changes
- [x] Store unit tests with PGlite — 31 tests, real SQL without Docker, driver-agnostic `Database` type
- [x] Move `test/containers.ts` → `dev/containers.ts` — shared with dev-infra
- [x] Three-tier test structure — unit (PGlite), integration (Docker + in-process), e2e (Docker + subprocess)
- [x] llmock replaces mock-anthropic + Ollama — fixture-based deterministic LLM responses
- [x] Integration tests — pipeline (in-process bootstrap + Inngest) + memory (Hindsight + llmock)
- [x] E2e smoke test — subprocess boot, migrations, one message end-to-end
- [x] `bootstrap()` extracted from `src/index.ts` — reusable wiring for tests
- [x] Test philosophy documented in CLAUDE.md — tiers, PGlite, llmock, env injection, Telegram strategy
- [x] Slim Hindsight image — external providers, no PyTorch, ~5s startup
- [x] llmock `requestTransform` — deterministic fixture matching with timestamp/UUID stripping
- [x] Docker-based e2e — builds from Dockerfile, tests real production artifact
- [x] Rename `cli.ts` → `main.ts`, fix Dockerfile entrypoint
- [x] CI: Codecov coverage, JUnit test reports, `dorny/test-reporter` job summaries
- [x] Hindsight provider config — production (OpenRouter + zerank-2) vs test (slim + llmock)
- [x] Streaming — unified DeliveryRouter, StreamingAdapter/StreamHandle, TelegramStreamHandle, chatStream() on LlmProvider
- [x] Web tools — web_search (Tavily), web_answer (Perplexity Sonar), fetch_url (readability + SSRF)
- [x] File tools — read_file/write_file/list_files via S3 (MinIO), Service.files namespace
- [x] Enhanced get_current_time — structured JSON, timezone, day of week, UTC offset
- [x] MinIO container in dev-infra and test setups
- [x] System prompt overhaul — auto-generated tools section, per-service guidance, conditional onboarding
- [x] Core memory blocks — DB table, core_memory_update/read tools, auto-recall, getUserContext callback
- [x] OpenAI-compatible LLM adapter — OpenAICompatibleProvider via official SDK
- [x] ImageBlock — canonical type, both adapters, Telegram photo handler, AttachmentStore (separate binary storage)
- [x] Steering rules table — already existed, injected into system prompt per invocation
- [x] Context window management — `countTokens()` on LlmProvider, model registry, three-layer compaction pipeline, usage tracking
- [x] Debounce wiring — debounce-router, debounce-idle, debounce-maxwait, entry guards, resume policy
- [x] Prompt caching — Anthropic cache_control, OpenRouter passthrough
- [x] Session lifecycle — Inngest idle timer, resolveSession staleness, `/new` command
