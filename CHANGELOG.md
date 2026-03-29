# Changelog

| Date | Change |
|-|-|
| 2026-03-29 | llmock replaces mock-anthropic + Ollama — `@copilotkit/llmock` 1.6.0 serves Anthropic API + OpenAI-compatible endpoints from fixtures. Single in-process instance backs both our app and Hindsight. Deleted `test/mock-anthropic/`. E2e drops from ~5min to ~1min. |
| 2026-03-29 | Integration tests (in-process) — `bootstrap()` extracted from `src/index.ts`, called directly in test workers. Env injection via `process.env` in globalSetup (propagates to Vitest workers). Pipeline + memory tests moved from e2e. E2e slimmed to boot smoke test. |
| 2026-03-29 | Three-tier test structure — unit (PGlite, mocks), integration (Docker + in-process), e2e (Docker + subprocess). Renamed `*.integration.test.ts` → `*.e2e.test.ts`. Moved `test/containers.ts` → `dev/containers.ts`. |
| 2026-03-29 | Store unit tests with PGlite — `@electric-sql/pglite` 0.4.2 (PG17 in WASM). `pushSchema` from `drizzle-kit/api` applies schema without migration files. `pg_uuidv7` extension + `uuidv7()` alias. 31 tests across 2 store files. Driver-agnostic `Database` type (`PgDatabase<PgQueryResultHKT>`) eliminates `as any` casts. |
| 2026-03-29 | Replace `pg` driver with `postgres.js` — pure JS, faster, modern. Swap `drizzle-orm/node-postgres` → `drizzle-orm/postgres-js` across 5 files. Zero API changes needed — Drizzle's connection pattern and `$client.end()` work identically. |
| 2026-03-29 | CLI entrypoint (`src/cli.ts`) — `serve` and `seed` commands. Seed script (`src/seed.ts`) extracted from app startup, runs independently with only `DATABASE_URL`. Dockerfile uses `ENTRYPOINT ["node", "dist/cli.js"]`. App fails fast if seed hasn't run. |
| 2026-03-29 | Channel registry — table-driven adapter discovery. `AdapterModule` contract (`channelType` + `setup()`) with `satisfies` barrel enforcement. Registry reads `channels` table, starts matching adapters, creates generic respond functions. No per-adapter respond files. |
| 2026-03-29 | Direct channel adapter — replaces old CLI adapter. Event-driven via Inngest (`adapter/direct/inbound`, `adapter/direct/outbound`). Console script (`scripts/console.ts`) for dev interaction. No in-process stdin/stdout. |
| 2026-03-29 | Code quality — shared test factories (`src/test/factories.ts`), `createRespond()` shared factory, `contentToText()` helper, neverthrow `Result<T, TransportError>` at Transport boundary, `#private` fields on all classes, `private constructor` + `static async create()`. 84 unit tests, 3 integration tests. |
| 2026-03-29 | Structural alignment — code matches design docs. Renamed `src/channels/` → `src/transport/`. Store pattern (`agent/store/`, `transport/store/`) with interfaces + Drizzle implementations. New schemas: channels, channel_sessions, inbound_messages, user_identities. Deleted: chats, deliveries, old enums. New events: `inbound/arrived`, `response/ready`. Handle-message receives IDs not raw content. 9 tables, fresh migration. |
| 2026-03-28 | Design doc cleanup — fixed stale refs across 8+ docs, added platform_ts to inbound_messages, updated infrastructure (testcontainers, no Docker Compose), fixed Drizzle example (UUIDv7), removed TELEGRAM_BOT_TOKEN from secrets (channels.credentials). |
| 2026-03-26 | Telegram adapter — grammY long polling, auth allowlist (TELEGRAM_ALLOWED_USERS), control commands (/start, /new) via CommandService, typing indicator. Opt-in via TELEGRAM_BOT_TOKEN. 74 tests across 14 files. |
| 2026-03-26 | Module restructure — handle-message to src/agent/, respond functions to src/channels/, src/inngest/ is core setup only. Module boundaries documented in CLAUDE.md. |
| 2026-03-26 | Channel architecture decisions — agent returns markdown (no rich intermediate repr), control commands intercepted by adapters, grammY over Telegraf. Documented in agents.md + decisions.md. |
| 2026-03-25 | Fix pipeline e2e test — switched from serve mode (HTTP) to connect mode (WebSocket). Connect mode eliminates function discovery timing issues: app initiates outbound connection to Inngest dev server, `connect()` blocks until handshake succeeds. Also fixed test userId (was string, needed UUID from default user). All 3 integration tests passing. |
| 2026-03-25 | Hindsight retain/recall integration test passing — Ollama qwen2.5:3b via @testcontainers/ollama. Migrated from DockerComposeEnvironment to individual testcontainers. Fixed PG18 volume path, Ollama healthcheck, Hindsight /health endpoint, Ollama base URL /v1 suffix. |
| 2026-03-24 | Tool system refactor — ToolCapabilities interface (ACL boundary), Zod input validation via defineTool(), memory_recall + memory_retain tools, Hindsight wired into orchestrator. 66 tests across 11 files. |
| 2026-03-24 | Design: tool architecture (capability interface, typed dispatch, plugin-ready), bank strategy (per-user + tags), memory ACL via tags (compartments + trust tiers), plugin trust tiers, Hindsight operations clarification (reflect ≠ consolidation) |
| 2026-03-23 | End-to-end message pipeline — LLM abstraction (provider-agnostic), agentic loop, CLI adapter, Inngest orchestration with DI, 37 unit tests |
| 2026-03-23 | Initial Drizzle migration generated and verified against PostgreSQL |
| 2026-03-23 | CLAUDE.md — design philosophy (early abstractions, event decoupling, thin infra), testing rules, DI stance, code style |
| 2026-03-23 | Replace BullMQ with Inngest — event-driven durable execution, added to Docker Compose, updated all design docs |
| 2026-03-23 | Add todo.md + `/next` command — priority-based task tracking |
| 2026-03-23 | Add confidence markers to all design docs (`[confirmed]`/`[proposed]`/`[research]`) |
| 2026-03-23 | Remove nucleus/NixOS-specific details — app is now deployment-agnostic |
| 2026-03-23 | Rewrite data-model.md — Drizzle as source of truth, lean Phase 1 schema (3 tables), deferred tables documented for later |
| 2026-03-23 | Add Docker Compose (PostgreSQL + pgvector, Redis), Drizzle schema + config, db connection module |
| 2026-03-23 | Scaffold Phase 0 — package.json, tsconfig, tsup, Biome 2.x, Vitest, Pino logger, env parsing (@t3-oss/env-core + Zod v4), directory structure |
| 2026-03-22 | Add tooling.md — dev stack research (pnpm, tsx, tsup, Fastify, Drizzle, Vitest, Pino, Biome, Remeda, neverthrow) |
| 2026-03-22 | Add data-model.md (unified PostgreSQL schema), testing.md (local dev, mocking, evaluation) |
| 2026-03-22 | Add session lifecycle, context window mgmt, message batching, Telegram auth to agents.md |
| 2026-03-22 | Add Hindsight deployment clarification, `claude -p` integration pattern to architecture.md |
| 2026-03-22 | PROGRESS.md: add missing Phase 0/1/2 tasks (schema, session lifecycle, auth, `claude -p`) |
| 2026-03-22 | Fix design doc gaps: stateless-per-invocation model, GroupQueue priority, signal capture schema, embedding model, Stage 4 graduation features |
| 2026-03-22 | Add PROGRESS.md — phased delivery plan (Phase 0-5) |
| 2026-03-22 | Initial design docs — 9 files distilled from 22 research docs |
