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

- [ ] Morning briefing — Inngest cron function
- [ ] Post-conversation extraction — Inngest delayed function
- [ ] Memory consolidation — daily `reflect()` via Inngest cron
- [ ] Agent self-scheduling tools — `schedule_task`, `list_tasks`, `remove_task`
- [ ] Human-in-the-loop — Inngest `step.waitForEvent()` + Telegram callback buttons
- [ ] Dual-mode monitoring for ingestion — embedding scan first, LLM only when relevant
- [ ] First ingestion agent: Gmail (MCP)
- [ ] First ingestion agent: Google Calendar (MCP)
- [ ] Concurrency control — per-conversation FIFO, global concurrency limit via Inngest

(Subscription-backed background coding tasks live in Phase 6 via `claude -p` / `codex exec` subprocess — see [Phase 6: Autonomous Coding + Sandbox](#phase-6-autonomous-coding--sandbox). The Agent SDK path is not used here; it requires API keys, not subscriptions.)

## Phase 3: Skill Library + More Integrations

The agent extends its own capabilities — authors small Python programs ("skills") that run in sandboxed workers, invoked as LLM tools or on cron. Design: [skills.md](design/skills.md).

### P3.1 — Foundation

- [ ] Skills store — `skills`, `skill_deploys`, `skill_runs`, `skill_context_calls` tables; Drizzle schema; `SkillStore` interface + impl; PGlite unit tests
- [ ] `SkillManifestSchema` — canonical Zod schema for `SKILL.md` frontmatter (name, description, tier, isolation, triggers, schedule, inputs/outputs, effects, secrets, resources, budget, cost_per_call_usd); `SKILL_EFFECTS` constant; manifest parser that strips frontmatter from markdown body
- [ ] Local skills repo bootstrap — initialize bare git repo at `$COGMO_SKILLS_PATH` (default `/var/lib/cogmo/skills`) on first boot; install `pre-receive` hook enforcing "main only via Cogmo" + force-push ban; `settings.local.json` config key

### P3.2 — Runtime

- [ ] Worker JSON-RPC protocol — framing over stdin/stdout, request/response shape per [skills.md](design/skills.md) → Host context; typed Python exceptions → typed TS errors
- [ ] Tier 1 worker (WASM/Pyodide) — Pyodide instance in a Node worker thread, fresh globals scope per task, V8 heap limit + host-side wall-clock timer; Pyodide-compatibility lint (no `subprocess`, no `os.fork`, only available wheels)
- [ ] Tier 2 worker (sysbox container) — Python subprocess inside a sysbox container (reuses [sandbox.md](design/sandbox.md) `Sandbox` interface), subinterpreter per task (Python 3.13+, PEP 684), per-run cgroup slice via sandbox cgroup parent; `isolation: recycle` opt-out path
- [ ] Pool + Dispatcher — min=1 / max=3 warm workers per tier, queue-with-spawn-on-threshold, worker replacement every 500 tasks or 30min idle, health checks. Also: deep-walk PyProxy destruction in `worker-entry.runTask` (P3.1 only destroys the top-level proxy because workers are one-shot; warm pool means nested PyProxies leak across tasks unless the conversion does a recursive destroy or `ctx.py` uses `pyodide.ffi.create_proxy` discipline).
- [ ] Python `ctx` SDK — shipped into every worker image; RPC-backed methods for `secrets.get`, `memory.recall`, `memory.remember`, `attachments.upload/download`, `llm.complete`, `now`, `user`, `notify`, `log.info`; manifest-gated at host side. Also: plumb `memory.recall.limit` to `maxTokens` proportionally instead of slicing client-side (P3.1 fetches the full result then slices — wastes bandwidth on high-recall queries; Hindsight's `RecallOptions` takes `maxTokens`, not item count).

### P3.3 — Deployment pipeline

- [ ] Risk classifier — deterministic, consumes `SkillManifestSchema` + static-analysis pass (AST lint for `subprocess`, `os.remove`, destructive SDK methods); assigns `auto` / `notify` / `approve`; forces declaration of any undeclared effect it detects
- [ ] `register` RPC — branch + fast-forward check + advisory lock (`pg_advisory_xact_lock` per skill name) + pending-deploy check + classify + atomic merge-and-write; returns `RegisterResult` synchronously
- [ ] `approveDeploy` / `denyDeploy` / `rollback` RPCs — Telegram approval flow for `approve` tier, `git update-ref` rollback to prior SHA with classifier re-run
- [ ] `cogmo skills` CLI — `register --branch X`, `rollback X`, `deregister X`, `list`, `run X '{}'` wrappers over the RPCs
- [ ] `/disable <skill>`, `/enable <skill>` channel commands — Telegram shortcuts for the same RPCs

### P3.4 — Invocation

- [ ] Dynamic tool registration — orchestrator rebuilds tool list each turn from `SkillRunner.list()`; one tool per skill (name + tier-1 description + compiled `inputs` schema); tier-2 SKILL.md body swapped into tool description on selection (progressive disclosure)
- [ ] Outputs validation against `manifest.outputs` JSON Schema in `runner.invoke` — P3.1 only validates inputs via ajv; a skill declaring `outputs: {type: "object"}` and returning a string silently stores the string in `skill_runs.output`. Outputs become load-bearing for tool-registration shapes, so validation has to land alongside dynamic tool registration. (TODO marker in `src/skills/runner.ts` `runner.invoke`.)
- [ ] Cron scheduling — one Inngest cron per scheduled skill (from `SKILL.md.schedule`), dispatcher fire-and-forget
- [ ] Failure handling — Inngest retries → Telegram notification on final failure → auto-disable after 3 consecutive failures → `/enable` / `/rollback` recovery
- [ ] Skill discovery retrieval layer — `search_skills(query)` tool (semantic search over manifest descriptions). Added when tool-list tokens exceed ~5k or tool-selection accuracy drops on evals

### P3.5 — Telemetry & cost

- [ ] `skill_runs` tracking — wall_clock_ms, peak memory (cgroup/isolate stats), status, error; Inngest step-wrapped for exactly-once
- [ ] `skill_context_calls` audit log — every `ctx.*` RPC with method + target (never value); retention policy
- [ ] Cost accounting — LLM tokens via `ctx.llm.complete()` (pricing table per model), declared `cost_per_call_usd` summed per run, dispatcher enforces daily/monthly budgets from `SKILL.md.budget`

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

## Monitoring Thresholds (Scaling Triggers)

| Signal | Action |
|-|-|
| RAM pressure or swap | Move to larger host or optimise |
| API costs unsustainable | Evaluate local inference for background tasks |
| pgvector index > 1GB | Evaluate dedicated vector store |
| >50 skills OR tool-list tokens > ~5k OR selection accuracy drop | Add `search_skills` retrieval layer (P3.4), hierarchical organization if still needed |
