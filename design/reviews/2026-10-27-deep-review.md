# Deep review, 2026-10-27

## Scope and method

The whole codebase at `main` e2962085, which passed typecheck, lint and knip. Nine read-only reviewers covered disjoint module clusters, and an orchestrator pass covered the import graph, design docs, CI and module map; every High and Medium-high finding was re-read against the cited lines.
Severity is for this deployment: one operator, personal data, and prompt injection reaching a privileged path as the real threat. Statuses are as of `main` on 2026-10-31. Each open finding has a `todo.md` entry ending in its id.

## Findings

Pointers are relative to `apps/server/src/` unless they start with `design/`, `apps/` or name a repo-root file.

| Id | Severity | Finding | Status | Pointer |
|-|-|-|-|-|
| H1 | High | Tier-1 skills run Pyodide in a worker that shares the host's environment, has no resource limits and keeps Python's bridge to the host's JavaScript, which reaches the environment, child processes and an unguarded fetch. A tier-1 skill with no effects classifies `auto` and goes live with no human gate, while the design calls the tier a capability-based sandbox. | open (todo) | skills/worker-wasm/worker-entry.ts, skills/worker-wasm/host.ts, skills/worker-wasm/wasm-lint.ts, skills/ast-classifier.ts, skills/deploy/register.ts, design/skills.md |
| H2 | High | Teardown runs git status, add, commit and push on the host, as the Cogmo user, inside the standalone clone the sandbox bind-mounts read-write. Repo-local hooks, fsmonitor, ssh command and credential helper settings in that clone run host code on any failure or cancel the model can provoke. | open (todo) | agent/coding/teardown.ts, agent/coding/worktree.ts, sandbox/supervisor.ts |
| H3 | High | The Docker API proxy injects labels but checks no ownership: a task can inspect, exec into, archive or kill any container, including a sibling's credentials or Cogmo's own. The create policy reads the body case-sensitively, denylists only eight capabilities, leaves volume, device and namespace options unfiltered, and the raw-piped hijack routes let a pipelined create skip it. | open (todo) | sandbox/proxy/router.ts, sandbox/proxy/policy.ts, sandbox/proxy/index.ts |
| M1 | Medium-high | The Telegram adapter has no private-chat guard, so a reply with full personal memory goes to every member of a group the bot is added to, though the design says DMs only. | open (todo) | transport/adapters/telegram/inbound-dispatch.ts, design/transport/telegram.md |
| M2 | Medium-high | Core memory blocks render verbatim into the system prompt, and their keys are free text the model writes, so one persuaded memory write becomes a standing system instruction or forges a top-level section. The turn-context path envelopes and escapes the same data. | open (todo) | agent/prompt.ts, agent/core-memory/write-core-memory-block.ts |
| M3 | Medium-high | Scheduled turns run with full user authority: the scheduled source drives routing only, so an injected turn can schedule a recurring prompt that delegates coding, writes memory and schedules again. | open (todo) | agent/scheduling/dispatch-fire.ts, agent/handle-message/inbound-batch.ts, design/evolution.md |
| M4 | Medium | Both LLM adapters report a stream that closed early as a complete end-of-turn reply, so the loop's missing-done guard never fires; the OpenAI-compatible adapter also folds unknown finish reasons into end of turn and never reads the refusal field. | open (todo) | llm/anthropic.ts, llm/openai-compat.ts, agent/loop.ts, design/providers.md |
| M5 | Medium | The in-cooldown reply step is gated on a bare-body clock, so a replay after the cooldown lapses runs a full turn after the "waiting" reply. | open (todo) | agent/handle-message/admit-turn.ts |
| M6 | Medium | The scheduling ticker commits the advanced next-run time in one step and emits the fire in a later one, so a crash between them loses the fire. | open (todo) | agent/scheduling/ticker.ts |
| M7 | Medium | Coding tasks' in-run terminal transitions were unconditional, so a Cancel during verify still pushed and opened a PR. | addressed (#696, #706) | agent/coding/task-failure.ts, agent/coding/verify-publish.ts |
| M8 | Medium | Batch delivery loops over adapters inside one step, so a failure on one adapter re-sends the full reply through the others on every retry. | open (todo) | transport/delivery-router.ts |
| M9 | Medium | Evolution memory extraction turns an LLM failure into zero memories extracted, so the audit row and the learned report show success; a test pins the swallow. | open (todo) | agent/evolution/extract-memories.ts |
| M10 | Medium | Channel sessions closed unconditionally and nothing stopped two active sessions on one address. | addressed (#698) | transport/store/index.ts, design/transport/sessions.md |
| M11 | Medium | Scheduled-fire and pipeline-stage inbounds are written read-then-insert against a unique key, which raises an unretried unique violation instead of recovering the row. | open (todo) | agent/scheduling/dispatch-fire.ts, agent/pipeline/run-agentic-stage.ts, transport/store/index.ts |
| M12 | Medium | Appending to a boundary hold that resolved in between updates no row, so the buffered inbound is silently lost. | open (todo) | transport/namespaces/boundary.ts, transport/store/index.ts |
| M13 | Medium | Skill approve wrote the skills projection before its guarded deploy update, and register deleted its branch before the commit, so a failure left the retry with no branch. | addressed (#697) | skills/store/index.ts, skills/deploy/register.ts |
| M14 | Medium | Rollback checks no deploy history, so a pending or denied sha can go live through the CLI. | declined (rollback is an owner-only CLI override of the approval gate, design/skills.md → Deploy lifecycle) | skills/deploy/rollback.ts |
| M15 | Medium | The skills library is one linear main, so a rollback drops later deploys of other skills from it and leaves their live shas unreachable. | open (todo) | skills/deploy/rollback.ts, design/skills.md |
| M16 | Medium | MCP schema pinning never runs at connect or call time, and server tool names pass through verbatim, so a name the provider rejects fails every turn of a profile that approved it. | open (todo) | mcp/registry.ts, mcp/approval.ts, mcp/config.ts, design/integrations/mcp.md |
| M17 | Medium | Skills deny reported success and exited 0 when nothing matched. | addressed (#697) | cli/skills.ts |
| M18 | Medium | Provider secrets are named after the provider through an upsert on name, so a provider named after a fixed-name secret (fal, tavily, daytona, openai) silently overwrites it. | open (todo) | agent/provider/add-provider.ts, cli/image-provider.ts, setup/wizard/image-providers.ts, secrets/store/index.ts |
| M19 | Medium | Request-log header redaction is a six-name denylist, so an operator-set provider header such as an Azure or proxy key is logged in plain text on every failed request, with the URL query intact. | open (todo) | llm/logging-fetch.ts |
| M20 | Medium | The coding progress stream, the persisted plan and the CLI's stderr log are unmasked, while every DB, event and PR sink is masked. | open (todo) | agent/coding/streaming-registry.ts, agent/coding/progress-subscriber.ts, agent/coding/orchestrator.ts, agent/coding/claude.ts |
| M21 | Medium | Provider API keys are argv positionals, visible in process listings and shell history. | open (todo) | cli/provider.ts, cli/image-provider.ts |
| M22 | Medium | Setup exits 0 when it failed, and a secrets reset fails on any deployment with a provider because the provider foreign keys block the delete. | open (todo) | main.ts, setup/reset.ts, agent/store/schema/llm-providers.ts |
| M23 | Medium | Setup saves a provider before asking whether to keep an invalid key, deletes existing config before its replacement is validated, and a non-interactive re-run regenerates the SSH signing key and wipes the Telegram channel's sessions, though the design calls it idempotent. | open (todo) | setup/wizard/llm-provider.ts, setup/wizard/telegram.ts, setup/non-interactive.ts, design/setup.md |
| M24 | Medium | deploy.md publishes the web port on all interfaces and never mentions the web UI, its login token or the loopback-or-proxy boundary the design relies on. | open (todo) | deploy.md, design/web-ui.md |
| M25 | Medium | The web login token has no operator rotation or revocation, the SPA's event stream reconnects forever on 401, 403 and 404 instead of returning to login, and the web server starts outside the shutdown cleanup. | open (todo) | web/auth/login-token.ts, apps/web/src/chat/use-chat.ts, main.ts |
| D1 | Medium | The transcript head check, its stored head and the epoch reason are described as current and `[confirmed]`; none exists yet. | open (todo) | design/crash-recovery.md, design/prompt-caching.md |
| D2 | Medium | The docs say every summarization and degraded-reply fork sends the turn's system prompt and tools with tool choice none; summarization sends no tools, degraded synthesis sends its own system prompt, and the call parameters have no tool choice. | open (todo) | design/prompt-caching.md, design/context-management.md, design/agent-resilience.md |
| D3 | Medium | The docs say a truncating turn opens an epoch; one opens only when the configuration digest or history start changes. | open (todo) | design/context-management.md, agent/handle-message/finalize-turn-context.ts |
| D4 | Medium | The `[confirmed]` proxy design specifies ownership checks, row inserts, an allowed-mount set, inherited caps and crash resume; none is implemented. | open (todo) | design/sandbox.md |
| D5 | Medium | The scheduling doc claims advance and emit share a transaction, a cap of 50 (the code uses 200), one-offs through a deferred Inngest event, and drift anchored to the schedule, all contradicted by the code. | open (todo) | design/scheduling.md, agent/scheduling/ticker.ts |
| D6 | Medium | The coding doc names a weekly WIP-ref prune that does not exist, a permission-prompt wait that is no longer a step wait, and an auth failure reason with no writer. | partly addressed (#706; the WIP-ref prune and the permission-prompt wait remain) | design/coding-delegation.md |
| D7 | Low | AGENTS.md lists 9 of 17 modules and the store-pattern rule lists 2 of 10 stores. | open (todo) | AGENTS.md, .agents/rules/store-pattern.md |
| D8 | Low | The data-model index misses 16 live tables and lists four live ones as deferred. | open (todo) | design/data-model.md |
| D9 | Medium | The architecture doc describes background work through the Claude CLI, tools through MCP and a future SSE interface, and says nothing about skills, sandbox, pipelines or the web UI. | partly addressed (#693; everything but Orchestration Coupling is stale) | design/architecture.md |
| D10 | Low | `[proposed]` markers sit on shipped, tested work (165 across design/), and `[confirmed]` sections describe pending rollout steps, so a reader cannot tell shipped from pending. | open (todo) | design/ |
| D11 | Medium | The `[confirmed]` setup doc contradicts the code on reset scopes, missing and undocumented steps, environment variables, saving invalid credentials, writing no files and the persistence table. | open (todo) | design/setup.md |
| D12 | Low | The migration rule forbids hand-written migration SQL, yet several migrations carry hand-written DML and the prompt-caching plan adds more. | open (todo) | .agents/rules/architecture-rules.md, design/prompt-caching.md |
| A1 | Medium | DB-backed provider and voice resolvers live in the infrastructure modules and import the agent store. | open (todo) | llm/resolver.ts, llm/image-providers.ts, llm/venice.ts, voice/resolver.ts |
| A2 | Medium | The secrets module hosts git, GitHub and SSH-key utilities that belong to the coding domain. | open (todo) | secrets/git-askpass.ts, secrets/github.ts, secrets/ssh-keygen.ts |
| A3 | Low | Adding a provider imports its key validators from the setup wizard, a domain-to-edge dependency. | open (todo) | agent/provider/add-provider.ts, setup/validate.ts |
| A4 | Medium | The Transport façade is the application-service layer for every operator command, several namespaces carry business logic, and agent and transport import each other's values. | partly addressed (#692; the façade split in design/operator-facade.md remains) | transport/namespaces/, design/operator-facade.md |
| A5 | Medium | Inngest's shape in the domain modules was undocumented. | addressed (#693) | design/architecture.md, inngest/durable.ts |
| A6 | Medium | The skills store runs the register, approve and rollback use cases with a filesystem side effect inside the transaction, and provider domain rules are enforced only in the CLI and repeated in setup. | open (todo) | skills/store/index.ts, cli/provider.ts, cli/model.ts, cli/image-provider.ts |
| A7 | Low | The sysbox worker host and worker import each other's values, which the code-style rule forbids. | open (todo) | skills/worker-sysbox/host.ts, skills/worker-sysbox/worker.ts |
| A8 | Medium | The agent loop, repair, the transport and skills stores, the Daytona client and the agentic pipeline stage are each several modules in one file, which is where replay invariants are hardest to review. | open (todo) | agent/loop.ts, agent/repair.ts, transport/store/index.ts, skills/store/index.ts, sandbox/daytona/client.ts, agent/pipeline/run-agentic-stage.ts |
| A9 | Low | The LLM layer signals expected failures through Error subclasses matched by instanceof and unwraps Results into throws, against the rule that expected failures are values. | open (todo) | llm/errors.ts, agent/loop.ts, agent/repair.ts, llm/typed.ts |
| A10 | Low | The orphan run-branch sweep gates its delete steps on a bare-body clock. | open (todo) | agent/coding/cleanup-orphan-run-branches.ts |
| S1 | Medium | The steering rule lifecycle was a boolean plus a timestamp whose meaning depended on the source. | addressed (#703) | agent/store/schema/steering-rules.ts |
| S2 | Medium | Pipeline run failure reasons were free text compared as strings. | addressed (#705) | agent/pipeline/store/schema.ts |
| S3 | Medium | Coding tasks held seven nullable per-state columns with no CHECK and a free-text failure reason. | addressed (#706) | agent/coding/store/schema.ts |
| S4 | Medium | Container status writes were unconditional and recorded no reap reason. | addressed (#695, #702) | sandbox/store/index.ts, sandbox/store/schema.ts |
| S5 | Medium | Skill runs and deploys had per-state columns with no CHECK tying them to status. | addressed (#704) | skills/store/schema.ts |
| S6 | Medium | The pipelines and sessions docs had `[confirmed]` sections with no transition or failure-mode table. | addressed (#698, #705) | design/pipelines.md, design/transport/sessions.md |
| S7 | Low | The skills worker state machine records why a worker died as a free string. | open (todo) | skills/worker-state.ts |
| S8 | Low | Steering rule categories are a closed set stored as text. | open (todo) | agent/store/schema/steering-rules.ts |
| L1 | Low | Code knip cannot see is dead: the non-streaming agent loop, memory retain, the sandbox networks and volumes tables and methods, channel credential updates and the proxy scope's parent row id. | partly addressed (#698; the command service is deleted, the rest remains) | agent/loop.ts, agent/service.ts, sandbox/store/index.ts, transport/store/index.ts, sandbox/proxy/types.ts |
| L2 | Low | The `llm` auto-recall mode is a stub that behaves as always while the enum accepts it. | open (todo) | agent/recall-gate.ts |
| L3 | Low | HEAD on the health route falls through to the SPA. | open (todo) | web/server.ts |
| L4 | Low | The git helper passes the whole host environment, master key included, to every git child. | open (todo) | secrets/git-askpass.ts |
| L5 | Low | Web fetch and skill HTTP share a DNS-rebinding window between the address check and the connect. | open (todo) | agent/web-tools.ts, skills/ctx-handler.ts |
| L6 | Low | Git remote URLs reach clone and remote commands without an end-of-options marker (operator input only). | open (todo) | transport/namespaces/repos.ts, skills/configure-remote.ts |
| L7 | Low | Image editing lets the model send any stored attachment path to the image provider. | open (todo) | agent/image-tools.ts |
| L8 | Low | Non-UUID ids reach UUID column comparisons and throw from Result-returning namespace methods; only scheduling guards. | open (todo) | transport/namespaces/ |
| L9 | Low | A tool's error message reaches the model's tool result and the errored-conversation event unredacted, while logs and spans redact it. | open (todo) | agent/loop.ts, agent/handle-message/report-turn-failure.ts |
| L10 | Low | Cooldown cause classification and elapsed-cooldown arithmetic, resilience business logic, live in the Inngest event module. | open (todo) | inngest/events.ts |
| L11 | Low | Pipeline output schemas the model writes compile with Ajv's strict mode off, which leaves regex patterns unchecked. | open (todo) | agent/pipeline/output-schema.ts |
| L12 | Low | Approve recompiles the lockfile, so a reviewed sha becomes unapprovable once a transitive dependency publishes a release. | open (todo) | skills/deploy/approve.ts |
| L13 | Low | The skills-remote wizard step imports the full environment at load, so every setup run requires the Hindsight variables. | open (todo) | setup/wizard/skills-remote.ts |
| L14 | Low | A duplicate provider name in the CLI surfaces as a raw database error with its SQL instead of a value. | open (todo) | cli/provider.ts, cli/model.ts |
| L15 | Low | A push failure on one streaming target fails the LLM iteration, re-running and re-billing the stream to the healthy targets. | open (todo) | agent/handle-message/, transport/delivery-router.ts |

## Architecture

- **Vendor boundaries hold.** Drizzle stays in stores, each SDK (Anthropic, grammY, dockerode, MCP, Octokit) in its module, the CLI and web edges depend inward only, and the web contract is type-only with a compile-time parity guard both ways.
- **Inward leaks remain** where infrastructure modules hold use cases (A1, A2, L10), a domain module imports the wizard (A3), and stores and the CLI hold domain rules (A6).
- **The Transport façade is the application-service layer.** The content model now lives in the domain; design/operator-facade.md plans the split of the façade from the channel contract (A4).
- **Inngest is a deliberate dependency of the domain.** design/architecture.md → Orchestration Coupling states the trade, and use cases plan steps through the project's durable port (A5).
- **State machines are exemplary where the rule was applied**: attachment originals, turn persistence, the coding claims, sandbox exec state, the MCP and skills pool machines, Telegram stream state. The bent lifecycles are now enums with conditional transitions and CHECKs (S1–S6, M7, M10).
- **Error channels diverge** in the LLM layer (A9).
- **Inngest discipline is strong**: replay tests on every orchestrator, step ids from SDK-local counters, the tool table frozen as a string, Zod-parsed memos. The slips are M5, M6, M11 and A10.
- **Size is the review cost.** The oversized modules (A8) are where replay invariants are hardest to check.

## What is done well

- Tests: replay suites asserting memoized-step byte equality, pure state machines tested fixture by event with seeded fuzzing, deny matrices for the proxy router and IP guard, and integration tests that assert the absence of calls.
- Data: keyed inserts recover through one upsert shape pinned on the real driver, the transactor retries serialization failures through the driver's cause chain, and JSONB columns validate at one point with lone-surrogate sanitising.
- Secrets never reach a query parameter, a Zod issue, a step result or a span, and redaction sits at the log and span sinks.
- The Telegram sender gate, the web auth chain, the boot checks, the SSRF guard and the image decode path each have the right shape and the right tests.
- CI enforces the schema-to-design check, Hadolint, CodeQL, dependency review and knip on every PR.
