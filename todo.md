# Todo

## Next

- [ ] `p1` Set up Inngest — add to Docker Compose, install SDK, verify connection with a smoke test function
- [ ] `p1` Generate initial Drizzle migration and verify it applies against Docker Compose PostgreSQL
- [ ] `p1` Verify Hindsight connects to PostgreSQL + pgvector — install client, test `retain()`/`recall()` round-trip
- [ ] `p1` CLI adapter — stdin/stdout channel for local testing (no Telegram needed yet)
- [ ] `p1` Agentic loop as Inngest function — event-driven, durable steps per Claude call + tool execution
- [ ] `p1` System prompt assembly — base prompt + steering rules + relevant memories
- [ ] `p1` `memory_recall` and `memory_retain` tools for the agent
- [ ] `p1` Memory: Hindsight integration — `retain()`, `recall()`, `reflect()`
- [ ] `p2` Typed LLM calls with Zod schemas + retry with feedback injection
- [ ] `p2` Telegram adapter — webhook handler, send/receive messages
- [ ] `p2` Channel registry — self-registration factory pattern
- [ ] `p2` Session lifecycle — conversation start/end, idle detection, new session on resume
- [ ] `p2` Steering rules table — injected into system prompt per invocation
- [ ] `p2` Post-conversation Observer — Inngest function triggered by `conversation/idle` event
- [ ] `p2` Instruction file (Stage 1 evolution) — corrections append to JSON, loaded into system prompt
- [ ] `p2` Context window management — token counting, truncate oldest messages
- [ ] `p2` Message batching — debounce rapid consecutive messages
- [ ] `p2` Internal tag stripping — `<internal>` tags visible to orchestrator, stripped before user
- [ ] `p3` Telegram auth — validate user_id against allowlist
- [ ] `p3` Basic health check endpoint (HTTP)

## Later

- [ ] `p2` Morning briefing — Inngest cron function (Phase 2)
- [ ] `p2` Post-conversation extraction — Inngest delayed function (Phase 2)
- [ ] `p2` Memory consolidation — daily `reflect()` via Inngest cron (Phase 2)
- [ ] `p2` Agent self-scheduling tools (Phase 2)
- [ ] `p2` Claude Agent SDK integration — background tasks via subscription (Phase 2)
- [ ] `p2` First ingestion agent: Gmail via MCP (Phase 2)
- [ ] `p2` First ingestion agent: Google Calendar via MCP (Phase 2)
- [ ] `p3` Skill library — Voyager pattern (Phase 3)
- [ ] `p3` MCP dynamic tool registration (Phase 3)
- [ ] `p3` Prompt optimization — evaluation rubrics, bootstrapped few-shot (Phase 4)

## Blocked

## Done

- [x] Initialize Node.js project (package.json, tsconfig, Biome, Vitest)
- [x] Set up TypeScript build (tsx watch, tsup production)
- [x] Install core dependencies
- [x] Set up directory structure
- [x] Docker Compose for local dev (PostgreSQL + pgvector, Redis)
- [x] Drizzle schema — Phase 1 tables (conversations, messages, steering_rules)
- [x] Design doc confidence markers (`[confirmed]`/`[proposed]`/`[research]`)
- [x] Decide orchestration: Inngest over BullMQ (event-driven durable execution)
