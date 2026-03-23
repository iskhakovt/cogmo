# Progress

## Phase 0: Project Setup

- [x] Initialize Node.js project (`package.json`, `tsconfig.json`, Biome, Vitest)
- [x] Set up TypeScript build (tsx watch for dev, tsup for production)
- [x] Install core dependencies (Anthropic SDK, BullMQ, Drizzle, Zod v4, Pino, Remeda, neverthrow, ts-pattern, etc.)
- [x] Set up directory structure (`src/`, `src/agents/`, `src/memory/`, `src/channels/`, `src/scheduler/`, `src/evolution/`)
- [ ] Database schema — run `migrations/001_init.sql` (see `design/data-model.md`)
- [ ] Verify Hindsight connects to PostgreSQL + pgvector
- [ ] Verify BullMQ connects to Redis (port 6380)
- [ ] Basic health check endpoint (HTTP)
- [ ] CLI adapter — stdin/stdout for local testing (no Telegram needed yet)

## Phase 1: MVP — Conversation + Memory

The minimum useful system: talk to it, it remembers things.

- [ ] Agentic loop — raw SDK while loop + tool dispatch (~200 lines with error handling, HITL, checkpointing)
- [ ] Typed LLM calls with Zod schemas + retry with feedback injection (Stage 3, day 1)
- [ ] Telegram adapter — webhook handler, send/receive messages
- [ ] Channel registry — self-registration factory pattern
- [ ] Memory: Hindsight integration — `retain()`, `recall()`, `reflect()`
- [ ] Memory: 4 networks (world, bank, opinion, observation)
- [ ] Memory: route intention gate — "does this query need memory?"
- [ ] `memory_recall` and `memory_retain` tools for the agent
- [ ] Post-conversation Observer — extract facts after ~5 min idle
- [ ] Instruction file (Stage 1 evolution) — corrections append to JSON, loaded into system prompt
- [ ] Steering rules table in PostgreSQL — injected into system prompt per invocation
- [ ] Internal tag stripping — `<internal>` tags visible to orchestrator, stripped before user
- [ ] Crash recovery — persist message cursor to PostgreSQL
- [ ] Session lifecycle — conversation start/end, idle detection (~5 min), new session on resume
- [ ] Context window management — token counting, truncate oldest messages at ~80% capacity
- [ ] Message batching — debounce ~2s for rapid consecutive messages
- [ ] Telegram auth — validate user_id against allowlist
- [ ] System prompt assembly — base prompt + steering rules + relevant memories

## Phase 2: Scheduling + Ingestion

The agent does things on its own, not just when you talk to it.

- [ ] BullMQ setup — queue, workers, connection to Redis
- [ ] Morning briefing job (daily cron)
- [ ] Post-conversation extraction as delayed BullMQ job
- [ ] Memory consolidation job (daily `reflect()`)
- [ ] Agent self-scheduling tools — `schedule_task`, `list_tasks`, `remove_task`
- [ ] Human-in-the-loop — BullMQ `waitForEvent()` + Telegram callback buttons
- [ ] Dual-mode monitoring for ingestion — embedding scan first, LLM only when relevant
- [ ] First ingestion agent: Gmail (MCP)
- [ ] First ingestion agent: Google Calendar (MCP)
- [ ] GroupQueue — per-conversation FIFO, global concurrency limit, user messages prioritized
- [ ] `claude -p` integration — child process spawning for background agents ($0 subscription tier)

## Phase 3: Skill Library + More Integrations

The agent extends its own capabilities.

- [ ] Skill library — `skills/code/` + `skills/description/`, Voyager pattern
- [ ] MCP dynamic tool registration — agent writes skill, registers as tool
- [ ] Human review gate for new skills — BullMQ + Telegram approval
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
| Node.js OOM or swap pressure | Move to Hetzner (EUR 10-30/mo) |
| API costs > EUR 50/mo sustained | Evaluate Mac Mini for local sub-tasks |
| pgvector index > 1GB | Evaluate dedicated vector store |
| >50 skills | Hierarchical skill organization |
