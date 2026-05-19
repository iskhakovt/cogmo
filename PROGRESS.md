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
- [x] Basic health check endpoint (HTTP) — `GET /health` with IETF `application/health+json` body, bound to `0.0.0.0:9090`, liveness-only

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
- [x] Guided setup wizard — `cogmo setup` via `@clack/prompts`, provider validation (`/v1/models`, `getMe`), Telegram channel + allowlist, re-runnable (Keep/Modify/Skip), `--reset` scopes, `--non-interactive` mode (fully reads `COGMO_*` env vars with `_FILE` support, validates before writing, idempotent on re-run), post-setup "how do I know it's working?" block with bot username
- [x] Telegram response formatting — `marked` + custom HTML post-processor, `renderOutput` on AdapterModule, `steering_rules.channel_type` scope, channel-scoped rules seeded at setup
- [x] Image generation — `generate_image` tool via Vercel AI SDK + `@ai-sdk/fal`, curated model catalog, mid-stream delivery via `tool_result` events in Telegram stream handle, batch delivery step-wrapped, integration test via scoped `fetch` injection (fal-mock)

## Phase 2: Scheduling + Ingestion

The agent does things on its own, not just when you talk to it.

Phase 2 is anchored on one new primitive — **user/agent-defined scheduled tasks** — that subsumes "morning briefing", ingestion polling, and any "remind me at X" surface. Static Inngest crons stay for genuinely system-wide jobs (memory consolidation). See [scheduling.md](design/scheduling.md) → Agent Self-Scheduling.

- [x] Post-conversation extraction — Observer on `conversation/idle` (shipped in Phase 1, runs delayed via `step.sleep("wait-for-silence", "5m")`)
- [x] Human-in-the-loop — Inngest `step.waitForEvent()` + Telegram callback buttons (shipped via coding slice 2 plan approval + slice 3 tool gate; reusable primitive)
- [x] Concurrency control — per-conversation FIFO (shipped: `concurrency: { limit: 1, key: "event.data.conversationId" }` in `handle-message`); global cap deferred until measured
- [ ] `scheduled_tasks` table + 1-min ticker dispatcher — DB-backed registry; `next_run_at` cron-anchored via `cron-parser` + IANA timezone; fan-out via `step.sendEvent` with idempotency key `${task_id}:${next_run_at.toISOString()}`; one-off reminders ≤1y skip the table via `inngest.send({ ts })`
- [ ] `schedule_task` / `list_tasks` / `remove_task` agent tools — `cron-parser` validation, min-interval ≥60s, per-user task cap; structured `Result<TaskCreated, ValidationError>` so the LLM self-corrects on malformed cron
- [ ] Synthetic conversation turn on fire — fire handler loads profile, builds scoped `Service`, replays stored prompt as user-role message; audit `source: 'scheduled_task'`; the scheduled-for timestamp is passed into the prompt so the model is self-aware about catch-up
- [ ] Wizard recurring-tasks step — optional, opt-in flow for "morning briefing at 7:30am" and similar; writes one `scheduled_tasks` row; re-runnable, removable via `/schedules`. Morning briefing is one *instance* of the primitive, not a special-cased function.
- [ ] `/schedules` channel command — view enabled + disabled, disable/enable/delete; identity-checked transport entry point (mirrors `/skills`)
- [ ] Memory consolidation — daily `reflect()` via static Inngest cron (genuinely system-wide, not user-defined)
- [ ] First ingestion agent: Gmail (MCP) — depends on MCP client Phase D (OAuth 2.1 + DCR, see todo); polling cadence is itself a `scheduled_tasks` row that runs an ingestion prompt
- [ ] First ingestion agent: Google Calendar (MCP) — same shape as Gmail
- [ ] Dual-mode monitoring for ingestion — embedding scan first, LLM only when relevant

(Subscription-backed background coding tasks live in Phase 6 via `claude -p` / `codex exec` subprocess — see [Phase 6: Autonomous Coding + Sandbox](#phase-6-autonomous-coding--sandbox). The Agent SDK path is not used here; it requires API keys, not subscriptions.)

## Phase 3: Skill Library + More Integrations

The agent extends its own capabilities — authors small Python programs ("skills") that run in sandboxed workers, invoked as LLM tools or on cron. Design: [skills.md](design/skills.md).

### P3.1 — Foundation

- [x] Skills store — `skills`, `skill_deploys`, `skill_runs`, `skill_context_calls` tables; Drizzle schema (`src/skills/store/schema.ts`, migration `0017_tough_bedlam.sql`); `SkillStore` interface + `DrizzleSkillStore` impl; PGlite unit tests
- [x] `SkillManifestSchema` — canonical Zod schema in `src/skills/types.ts` (name, description, tier, isolation, triggers, schedule, inputs/outputs, effects, secrets, resources, budget, cost_per_call_usd); `SKILL_EFFECTS` constant; manifest parser in `src/skills/manifest.ts` strips frontmatter, returns `Result`
- [x] Local skills repo bootstrap — `bootstrapSkillsRepo()` in `src/skills/repo.ts` idempotently initializes bare git repo at `$COGMO_SKILLS_PATH`; pre-receive hook enforces "main only via Cogmo" + force-push ban; wired into `src/index.ts` boot path

### P3.2 — Runtime

- [x] Worker JSON-RPC protocol — framing + request/response shapes in `src/skills/protocol.ts`; Zod schemas for `TaskInvoke` / `TaskResult` / `CtxCall` / `CtxResult`; typed Python exceptions → typed TS errors
- [x] Tier 1 worker (WASM/Pyodide) — `runOnWorker()` in `src/skills/worker-wasm/host.ts` spawns fresh worker per task, SAB interrupt + hard-terminate fallback on wall-clock cap; Pyodide-compatibility lint in `src/skills/worker-wasm/wasm-lint.ts` (no `subprocess`, no `os.fork`, only available wheels)
- [x] Tier 2 worker (sysbox container) — Python subprocess inside a sysbox container (reuses [sandbox.md](design/sandbox.md) `Sandbox` interface), per-run cgroup slice via sandbox cgroup parent. Spawn-per-task shipped in P3.2.A, warm pool in P3.2.B.1, pre-fork supervisor in P3.2.B.2 — `isolation: subinterpreter | recycle` enum honoured at the worker level (recycle poisons after task; subinterpreter is the default fork-per-task model today). PEP 734 subinterpreters deferred until ecosystem maturity (see todo).
- [x] Dispatcher (P3.1 shape) — `Dispatcher` in `src/skills/dispatcher.ts` drives a single task over the transport with concurrent ctx-call correlation. Pool warming, min/max worker tracking, replacement-after-N-tasks, health checks deferred until Tier 2 lands.
  - [x] Pool warming + sizing (tier-2, P3.2.B.1) — `SysboxWorkerPool` in `src/skills/worker-sysbox/pool.ts`: min=1 / max=3, spawn-on-demand up to max, recycle every 500 tasks or 24h age, idle sweep above min after 30min. Tier-1 (Pyodide) pool deferred — see todo.
  - [x] Pre-fork supervisor (tier-2, P3.2.B.2) — `supervisor.py` runs once per warm worker, forks a fresh child per `task_invoke` (~10-30ms COW from a parent that pre-imports `asyncio` / `json` / `traceback` / `uuid`). Wall-clock kill via `os.pidfd_open` + `selectors.select(timeout=...)` + `SIGKILL`. Children inherit stdin/stdout cleanly (real `os.fork()`), so the existing `runner.py` ctx-bridge runs unchanged in the child. `isolation: recycle` poisons the worker after the task. PEP 734 subinterpreters deferred — see todo.
  - [ ] Deep-walk PyProxy destruction in `worker-entry.runTask` — P3.1 destroys only the top-level proxy because workers are one-shot; warm tier-1 pool would leak nested PyProxies across tasks unless the conversion does a recursive destroy or `ctx.py` uses `pyodide.ffi.create_proxy` discipline. Reactivates when tier-1 pooling lands.
- [x] Python `ctx` SDK (v1 subset) — `DefaultCtxHandler` in `src/skills/ctx-handler.ts` ships 6 methods: `secrets.get`, `memory.recall`, `memory.remember`, `now`, `user`, `log.info`; manifest-gated; audit row per call
  - [ ] `attachments.upload/download` (Service.files via S3) — needed before image-producing skills
  - [ ] `llm.complete` — needed before any skill calls an LLM through Cogmo's provider routing (also unblocks cost tracking in P3.5)
  - [ ] `notify(channel, message)` — outbound delivery via existing `DeliveryRouter` for cron/event-driven skills
  - [ ] `memory.recall.limit` semantics — currently slices client-side from a `maxTokens` budget; decide between adding an item-count `limit` upstream in Hindsight, keeping the client-side slice, or dropping `limit` from the Python ctx surface entirely. Decide once a real consumer materialises.

### P3.3 — Deployment pipeline

- [x] Risk classifier — `classifyManifest` in `src/skills/classifier.ts` runs a tree-sitter Python AST walk over `skill.py` (rules in `ast-rules.ts`), detects undeclared effects (`subprocess.*`, `os.system`, `open(..., "w")`, `smtplib`, `stripe`, …), rejects the deploy with per-effect labels when the manifest doesn't match, and promotes truly side-effect-free skills to the `auto` tier. Stub `classifyManifestStub` retained as the fallback when the parser load throws (logged with `event: classifier_fallback`). UX gate, not a security boundary — `getattr(__import__("os"), "system")(...)`-style bypasses are a known false negative; sysbox + `effects`-driven secret allowlists carry the actual security weight.
- [x] `register` RPC — `SkillRunner.register({branch})` reads SKILL.md + skill.py from the branch tip, advisory-lock per skill name (`pg_advisory_xact_lock(hashtext("skill_register:" + name))`), no-op + pending-deploy + fast-forward checks, atomic `git update-ref refs/heads/main` + DB upsert in one transaction. Returns synchronous `RegisterResult` (`live` / `pending_approval` / `no_op` / `rejected`).
- [x] `approveDeploy` / `denyDeploy` / `rollback` RPCs — `approveDeploy({pendingId})` advances main + flips deploy to `live` (re-checks fast-forward at approve time); `denyDeploy({pendingId, reason})` resolves the pending row to `denied` (idempotent on missing/already-resolved); `rollback({name, toGitSha})` rewinds main + re-classifies the target SHA. Telegram approval keyboard wiring is a follow-up sub-item below.
  - [x] Telegram approval inline keyboard for `approve`-tier deploys (Approve / Deny) — `Service.skills.register` emits `skills/deploy/approval-requested` on pending_approval; per-channel Inngest function `telegram-skills-approval-${channelId}` posts the keyboard with skill summary + declared effects; `transport.skills.{approveDeploy,denyDeploy}` provides the identity-checked callback target; `handleSkillsApprovalCallback` edits the message in place + clears the keyboard on tap.
- [x] `register_skill` agent tool — `src/skills/skills-tool.ts` + `Service.skills` namespace; wraps the RPC. `SKILLS_PROMPT_GUIDANCE` instructs the agent to author via `delegate_coding` then register.
- [x] `cogmo skills` CLI — full surface: `register <branch>`, `approve <pendingId>`, `deny <pendingId> [reason]`, `rollback <name> <sha>`, `deregister <name>`, plus the existing `list` / `run`.
- [x] `/disable <skill>`, `/enable <skill>` channel commands — Telegram shortcuts plus a `/skills` listing surface (enabled + disabled). `/enable` refuses skills whose current sha was never live (denied-on-first-deploy guard); enable/disable are idempotent on already-enabled / already-disabled rows.

### P3.4 — Invocation

- [x] Dynamic tool registration — `handle-message` rebuilds the tool list each turn: clones the bootstrap registry via `ToolRegistry.snapshot()`, then merges in one tool per live skill via `SkillRunner.listToolDefs()` + `buildSkillToolSpec`. Skills registered between turns appear immediately; disabled / rolled-back skills disappear. Source loading is keyed by `(name, gitSha)` so re-deploys invalidate cache automatically. Tier-2 SKILL.md body swapping on selection is a follow-up:
  - [ ] Progressive disclosure: swap the full SKILL.md body into the tool description on selection (today the description is the manifest's one-line `description` field only)
- [x] Outputs validation against `manifest.outputs` JSON Schema in `runner.invoke` — ajv-compiled and run before persisting; mismatch becomes `status=error` with the schema-failure detail.
- [x] Cron scheduling — parallel `skill-cron-ticker` (1-min Inngest cron, `src/skills/cron-ticker.ts`) locks rows from `skills` where `schedule IS NOT NULL AND disabled = false AND next_run_at <= now()`, advances `next_run_at` via `computeNextRun` shared with the agent-scheduled-prompt ticker, fans out `skills/cron.fire`. The `skill-cron-fire` handler (`src/skills/cron-fire-handler.ts`) calls `runner.invoke` with empty inputs and `trigger='cron'`; manifest-author foot-guns (`required` inputs on a cron-scheduled skill) surface as a `skipped: invalid_inputs` result instead of an Inngest retry storm. Disabled / deregistered between tick and fire returns `skipped: skill_not_found` / `skill_disabled`. See changelog `2026-05-19-skill-cron-dispatch.md`.
- [x] Exactly-once invocation — `runner.invoke` accepts an `idempotencyKey` parameter and participates in a Stripe-pattern `recovery_point` state machine at the DB layer (`started → executed → finished`). Retries with the same key replay or finalize without re-running the skill body. Cron-fire passes `skill-cron:${skillId}:${scheduledFor}` (same shape as the event-bus dedup id). Conservative refusal on mid-execute crashes via `SkillInflightCrashedError`; future manifest flag `idempotent_invocation: true` would opt into optimistic re-execute. Agent-loop tool dispatch deferred (needs `toolUseId` threaded). Pattern chosen over Inngest-step-splitting after research across Temporal, Brandur/Stripe, exactly-once.github.io, and the transactional-outbox literature converged on "DB-level beats framework-level." See changelog `2026-05-19-skill-runs-idempotency.md` and `design/skills.md` → Exactly-once invocation.
- [ ] Failure handling — Inngest retries → Telegram notification on final failure → auto-disable after 3 consecutive failures → `/enable` / `/rollback` recovery
- [ ] Skill discovery retrieval layer — `search_skills(query)` tool (semantic search over manifest descriptions). Added when tool-list tokens exceed ~5k or tool-selection accuracy drops on evals

### P3.5 — Telemetry & cost

- [x] `skill_context_calls` audit log — every `ctx.*` RPC persisted with method + target (name only, never value), indexed by `run_id`; retention policy deferred
- [x] `skill_runs` tracking — `resource_usage` JSONB column on `skill_runs` (`SkillRunResourceUsageSchema`, validated on read+write via `jsonbZod`). `wallClockMs` is host-derived from `finishedAt - createdAt` and always set; `peakMemoryBytes` rides back via the `task_result.rusage` block populated by tier-2 `runner.py` calling `getrusage(RUSAGE_SELF).ru_maxrss * 1024` just before emit. Tier-1 (Pyodide WASM) leaves `peakMemoryBytes=null` — `getrusage` is process-wide and would inflate under concurrent workers; tier-2 synthesised results (wall-clock kill, supervisor watchdog) also leave it null. See changelog `2026-05-19-skill-runs-resource-usage.md`.
- [ ] Cost accounting — LLM tokens via `ctx.llm.complete()` (pricing table per model), declared `cost_per_call_usd` summed per run, dispatcher enforces daily/monthly budgets from `SKILL.md.budget`. Blocked on `ctx.llm.complete` (P3.2 remainder).

### P3.6 — Deferred (future `[research]`)

- [ ] Egress-proxy secret substitution — UUID placeholder + HTTP egress proxy that validates destination against secret binding and substitutes on the fly
- [ ] Inter-skill composition — `ctx.skills.invoke(name, inputs)` orchestrator-mediated, recursion cap, permission intersection
- [ ] Agent-led repair loop — on `skill/failed`, spawn an orchestrator run to diagnose + patch + re-register (aligns with evolution stage 3+)
- [ ] Audit fail-closed semantics for sensitive ctx methods — P3.1 `ctx-handler.#audit` is fail-open: a DB hiccup logs a warn but lets the skill continue, so a successful `secrets.get` can return the value to Python without the audit row landing. Decide (after threat-model review) whether sensitive methods like `secrets.get` should refuse to return on audit failure while low-risk methods like `now()` stay fail-open. (TODO marker in `src/skills/ctx-handler.ts` `#audit`.)
- [ ] Additional integrations (as needed): Strava, banking, GitHub — Phase 3 scope retained

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

(Sandbox execution for generated code is delivered by Phase 6 — see [Phase 6: Autonomous Coding + Sandbox](#phase-6-autonomous-coding--sandbox).)

## Phase 6: Autonomous Coding + Sandbox

Cogmo delegates heavy coding tasks (and evolution-driven code changes) to `claude -p` / `codex exec` running in isolated containers. Design: [sandbox.md](design/sandbox.md), [coding-delegation.md](design/coding-delegation.md).

### P1 — core loop

- [x] Sandbox primitives (slice 1 — partial: `containers` + `cogmo_instances` tables, sibling-container creation with `sysbox-runc` runtime, Docker-label lineage, supervisor + crash recovery via instance-label reconcile. Deferred to slice 3: socket proxy, reaper cron, cgroup parent, `networks` + `volumes` tables — they only earn their keep once execute-mode tool calls can spawn child containers.)
- [x] Claude backend (plan-only) — subprocess wrap of `claude -p`, JSONL stream parsing, session-id capture, `plan_ready` event; prompt skeleton with task-specific slots only (repo conventions come from Claude Code's native memory tiers — managed policy + user-global + project — not prompt injection); `coding_tasks` / `coding_repos` tables; `delegate_coding` agent tool + `Service.coding` namespace runs the orchestrator inline (durable Inngest function ships in slice 2 when approval needs `step.waitForEvent`); `cogmo/devbase:slice1` image (Node 24 + claude-code 2.1.119); GHA `sysbox-e2e` job verifies the runtime delivers userns isolation
- [x] Plan approval + execute (slice 2) — Telegram inline-keyboard gate (Approve / Revise / Cancel) with strict identity check via `transportStore.resolveUser`; atomic `approvePlanIfPending` makes double-tap idempotent; conversational revise (cancel + re-delegate); `ClaudeCodeBackend.execute(ctx, sessionId)` runs `claude --resume <sid> --permission-mode acceptEdits`; durable `coding-task-execute` Inngest function reuses-or-recreates the task container; per-task `CodingProgressSubscriber` edits a single Telegram message in place across plan + execute via the new `CodingStreamingRegistry` (in-process EventEmitter pub/sub, matches industry split for token streams); `Service.coding.delegate` becomes the async submit path; admission check lands at the boundary; `pending_verify` enum value (migration 0011) names the post-execute transient between `executing` and `verifying`
- [x] Tool gate (slice 3) — Docker socket proxy with policy on `POST /containers/create` (deny privileged / host-net / host-path binds / dangerous caps; inject runtime + cgroup parent + Cogmo labels) and wholesale block on `/swarm` / `/plugins` / `/nodes`; per-task Unix socket bind-mounted at `/var/run/docker.sock` so child container creation flows through the proxy; reaper cron runs every minute (TTL pass + orphan detection + stale-row sweep + networks/volumes); cgroup parent (`cogmo-task-<id>.slice`) pins every container in the task tree to the same systemd subtree; pure in-process policy table (`src/agent/coding/policy.ts`) classifies tool calls — default-broad allow, narrow prompt set on external state changes only, empty deny set; `ClaudeCodeBackend.execute` drops `--permission-mode acceptEdits` and routes every tool call through stream-json `control_request` / `control_response` over stdin; orchestrator wires `policy.evaluate` + `coding_tool_decisions` log replay + Telegram inline keyboard (Once / Task / Deny) with `step.waitForEvent` blocking until the user taps; new tables `networks`, `volumes`, `coding_tool_decisions` (migration 0012); design markers `Tool gate`, `Proxy Design`, `Reaper`, `Lifecycle`, `Networks/Volumes/Images`, `Crash Recovery`, `Data Model` upgraded to `[confirmed]`.
- [x] Verify + push + draft PR (slice 4) — `coding-task-verify` Inngest function on `coding/task/cli-done` drives `runVerifyStreaming` → `runCommitAndPush` → `runOpenDraftPr` with durable `step.run` boundaries; status flows `pending_verify → verifying → pushed → pr_open`; SSH-signed commits via per-invocation `git -c gpg.format=ssh -c user.signingkey=<path> commit -S`; HTTPS push via `GIT_ASKPASS` helper material in `${SANDBOX_ASKPASS_DIR}/<task-id>/` mounted read-only at `/.cogmo-askpass/`; draft PR via `@octokit/rest` v22 with title=task.goal trunc 70 chars, body=plan + verify output. New `github_identity:<name>` secret convention bundles `{pat, sshPrivateKey, sshPublicKey}` (atomic by `GitHubIdentitySchema`), per-repo override via `coding_repos.identity_name`. Setup wizard generates an Ed25519 signing keypair via `micro-key-producer/ssh.js` and prints the public key + GitHub settings link. `Transport.repos.cloneAndAdd` + Telegram `/repo add` FSM dialog clones private repos using the bot PAT through a one-shot host-side askpass helper. Schema: `coding_repos.identity_name` + `verify_timeout_seconds`; `coding_tasks.pr_url` replaced with `coding_tasks.pr_metadata JSONB`. Design markers `Flow` / `Git Identity` / `Repo Registry` / `Merge gate` upgraded to `[confirmed]`. WIP-ref push on verify-fail deferred (todo p3).

### P2 — breadth + hardening

- [ ] Codex backend — second `CodingBackend` impl behind same interface
- [ ] Proxy policy enforcement — deny `Privileged`, `NetworkMode=host`, out-of-scope binds, dangerous caps; runtime injection; registry allowlist
- [ ] Devcontainer parsing — honour `.devcontainer/devcontainer.json` via devcontainer CLI
- [ ] Vault socket for credentials — disk-based `.git-credentials` replaced with per-task Unix socket helper
- [ ] GitHub App migration — installation tokens with ~1h expiry
- [ ] Extract sandbox proxy to sidecar — `cogmo sandbox-proxy` subcommand, tRPC control plane
- [ ] Automated self-modification surface — admission & rate limiting (global cap, per-source quotas, failure backoff, user-priority scheduler); wire `trigger_source IN ('evolution','signal_pipeline')`; expose steering-rules / prompts direct read/write capabilities
- [ ] Coding-scoped steering rules in `DefaultPromptSource` — layer `coding-claude` / `coding-codex` profile rules into the prompt skeleton

### P3 — polish

- [ ] Parallel tasks per repo — raise `max_concurrent_tasks`; install-lock on shared cache volumes (option B), narrow to pip/apt after measurement (option C)
- [ ] BuildKit policy enforcement — gRPC inspection via moby/buildkit SDK; block unapproved `FROM` lines, inspect secret mounts
- [ ] Observer repo-knowledge loop — post-task Observer files a `trigger_source='evolution'` coding task whose goal is a `CLAUDE.md` edit; native Claude Code memory loads it on future tasks (no Cogmo-private store)
- [ ] Plan-age confirmation — "still want to proceed?" Telegram prompt when execution would start >24h after approval

### Test infrastructure & e2e coverage (deferred to broader integration tier)

These items came out of the testing retrospective on PRs #76/#78/#80/#86 (resolved 2026-04-30). They aren't slices of the coding loop itself; they all need integration-tier infra not yet in place (real Inngest in test, testcontainers-backed Docker, Telegram Test DC, real GitHub PAT). Promote to Next individually when the underlying infra lands.

- [ ] **Real Inngest in integration tier** — current integration tests use a `stepRun` shim that bypasses Inngest's re-execution semantics. With real Inngest, exercise: orchestrator step boundaries under retry (verify orchestrator idempotent retries, tool-gate `step.waitForEvent` 7-day timeout, plan-approval timeout); `runCodingTask` durable boundaries; cross-event-handler flow on real `step.sendEvent`. Blocks slice C audit-invariant integration tests and the Inngest distributed-transaction tests (retrospective common-pattern #10).
- [ ] **Reaper actual-Docker integration** — testcontainers-backed test that creates real containers, lets TTL expire, runs `runReap`, asserts containers are gone from Docker AND DB rows are marked `reaped`. Slice G item.
- [ ] **Container teardown on task failure (real Docker)** — task fails during plan/execute → orchestrator's failure cascade → container actually stopped via Docker API (not just `stopTask()` mocked). Slice G item.
- [ ] **Cgroup parent enforcement (sysbox)** — spawn a memory-hog workload inside a task container with a 128 MB limit; expect OOM kill; verify the kernel enforces at the slice level. e2e GHA job already installs sysbox 0.7.0.
- [ ] **Sysbox + buildx siblings** — inside a sysbox task container, run `docker buildx build`; verify a buildkitd sibling appears with correct `cogmo.*` labels and the proxy's HTTP/1.1 upgrade handler proxies the gRPC-over-HTTP/2 traffic. Covers the slice 3 `/session` upgrade path end-to-end.
- [ ] **Full delegate→PR e2e** — single test exercising the full flow: real Inngest + real Postgres + real Docker + sysbox + Claude Code CLI + Gitea (or GitHub test repo). Today each phase has its own integration test; nothing covers all four phases as one flow.
- [ ] **Octokit real-API smoke** — at minimum, validate the `pulls.create` request payload shape against octokit's schema locally (without a real API call). Optionally a manual job against a test-org repo with a stored PAT.
- [ ] **Telegram message delivery integration** — real Telegram Test DC + tgintegration (TypeScript/mtcute), validate progress-message editing, plan-approval keyboard tap, permission-prompt round-trip. Already noted as `p3` in `todo.md`.
- [ ] **PR-open → Telegram audit invariant** — cross-module test asserting `status === pr_open` produces `coding/task/pr-opened` event AND a Telegram message reaches the conversation's session.
- [ ] **Setup wizard e2e** — fake-tty test running `cogmo setup` with scripted input, asserting config is written correctly.
- [ ] **Version-pinning canaries** — explicit tests that octokit, dockerode, sysbox image tag, Claude CLI flag set haven't drifted. Pin versions in fixtures and assert the CLI/API surface our code uses still exists. Currently a runtime regression would only surface in an integration test.

## Monitoring Thresholds (Scaling Triggers)

| Signal | Action |
|-|-|
| RAM pressure or swap | Move to larger host or optimise |
| API costs unsustainable | Evaluate local inference for background tasks |
| pgvector index > 1GB | Evaluate dedicated vector store |
| >50 skills OR tool-list tokens > ~5k OR selection accuracy drop | Add `search_skills` retrieval layer (P3.4), hierarchical organization if still needed |
