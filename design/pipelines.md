# User-Defined Pipelines

The user defines multi-stage agentic pipelines **in free text**; Cogmo compiles the text into a typed, reviewable pipeline definition and executes runs durably with human gates, long waits, and bounded loops.

> "On Linear issue → gather context with back-and-forth on Telegram → draft a plan → discuss the plan → implement → open PR → wait for review comments → address them → repeat until merged."

Linear is illustrative — no Linear integration is planned. The design point is a generic trigger surface; concrete trigger sources arrive independently.

## Purpose `[proposed]`

Coding delegation ([coding-delegation.md](coding-delegation.md)) is one hardcoded pipeline: trigger = chat command, stages = plan → approval gate → execute → verify → PR. This doc generalizes that shape so the user can author their own variants — different gates, different stages, different triggers — without Cogmo code changes.

In scope: the pipeline definition model, NL→definition compilation, the execution/durability model, gates, loops, safety. Out of scope: any specific trigger integration (Linear, GitHub webhooks) — each is its own follow-up with this doc defining the slot it plugs into.

## Research Base `[research]`

Surveyed June 2026: GitHub Agentic Workflows (gh-aw, public preview), Claude Code skills/subagents/hooks/workflows, Devin playbooks, Factory.ai droids, OpenHands microagents, Copilot coding agent, n8n AI builder, Zapier Agents, Lindy/Gumloop, Inngest workflow-kit/AgentKit, LangGraph, Temporal, Restate, DBOS, 12-factor-agents, StateFlow/AlphaCodium. Key findings the design below rests on:

| Finding | Evidence |
|-|-|
| Nobody ships a first-class user-defined pipeline (declared stages + typed human checkpoints). Devin playbooks and Copilot custom agents come closest but stay prompt-level — ordered NL steps with no enforced gates. | Devin playbook docs; Copilot coding-agent docs |
| **Compile the envelope, interpret the prose.** gh-aw freezes triggers/permissions/tools/guardrails into a compiled artifact; the NL body is loaded at runtime. Same split as 12-factor-agents F8 ("own your control flow"). | gh-aw compilation-process docs; GitHub Next retrospective |
| **Never let the LLM emit raw pipeline JSON.** n8n's builder LLM can only call schema-validated mutation tools — "hallucinations fail at the tool boundary." | n8n AI Workflow Builder (third-party code analysis) |
| **Deterministic outer loop, LLM quarantined inside steps.** The LLM may choose among predeclared transitions but never owns the loop's lifecycle. Near-unanimous: Anthropic, OpenAI, Temporal, Inngest, Cognition, 12-factor-agents. | "Building Effective Agents"; Temporal "deterministic but not predetermined" |
| **Visual builders are losing.** OpenAI Agent Builder shutting down (Nov 2026), LangGraph Builder archived, Copilot Workspace sunset. Text preview + conversational refinement is the converged UX. | OpenAI deprecations page |
| **The draft PR is the durable checkpoint** for review loops — comments re-trigger an agent session on the same branch with retained context. Universal across Devin Autofix, Copilot, Factory. | Devin "closing the agent loop"; Copilot docs |
| **One linear agent per PR thread, full context.** Don't decompose into parallel sub-agents that summarize at each other — "actions carry implicit decisions." | Cognition "Don't Build Multi-Agents" |
| **Bound every human wait** with a timeout + default action (remind/proceed/abort). No vendor documents an unbounded wait. | Temporal HITL tutorial (5-day auto-reject); Inngest `timeout: '7d'` examples |
| Long-lived single durable functions pin in-flight runs to old code. Temporal shipped pinned worker versioning + upgrade-on-continue-as-new (Mar 2026) specifically for "AI agent workflows with extended waits." Inngest's versioning is fail-soft (step-ID memoization, warnings not errors) — safe for short runs, silent-drift hazard across week-long waits. | Temporal changelog; Inngest versioning docs; Restate immutability critique |
| Inngest self-hosted limits: 1000 steps/run default (raisable to 10k), 32 MB run state, 4 MB step output, ~1-year wait ceiling. Sleeping/waiting runs cost nothing. The 7-day free-tier wait cap is Cloud billing, not an engine constant. | Inngest usage-limits docs; `pkg/consts/consts.go` |
| gh-aw retrospective: the hard problem was "operational trust, not technical feasibility" — declarative, reviewable, versioned guardrails; no hidden prompts. | GitHub Next retrospective |

Full source list at the bottom.

## Core Decision: Compile the Envelope, Interpret the Prose `[proposed]`

The user's free text is compiled **once, at definition time**, by an LLM with a typed contract (Zod in/out, retry + feedback injection — the existing pattern from [architecture-rules](../.claude/rules/architecture-rules.md)) into a `PipelineDefinition`. Two layers with different determinism:

- **Envelope (compiled, frozen per version):** trigger, stage sequence, gate placement, loop bounds, per-stage tool allowlists, budgets. Deterministic, reviewable, enforced by code.
- **Stage instructions (prose, interpreted per run):** each stage's `instructions` field carries the user's own words, handed to the agent loop at execution time. This preserves gh-aw's "productive ambiguity" — the user writes *what*, the agent decides *how*, the envelope decides *whether/when/with-what*.

```typescript
// All schemas are Zod; the compiler LLM produces this via structured output.
interface PipelineDefinition {
  name: string;                       // user-facing handle
  trigger: Trigger;
  stages: Stage[];                    // execution order; ids are stable + unique
}

type Trigger =
  | { kind: "event"; source: string; filter?: string }   // source = inbound event name, e.g. "github/pr.review_submitted"
  | { kind: "cron"; schedule: string; timezone: string } // dispatched by the scheduled_tasks ticker
  | { kind: "command"; phrase: string };                 // chat-invoked, e.g. "run the release pipeline"

interface Stage {
  id: string;                         // stable slug — run state and resume keys hang off it
  kind: "agentic" | "gate" | "wait";
  instructions?: string;              // the user's prose, interpreted at run time. Required for agentic/gate (validation pass enforces); optional annotation on wait stages, which have nothing to interpret.
  tools?: string[];                   // allowlist globs resolved against the tool registry (envelope, not prose)
  output?: StageOutput;               // typed handoff to later stages
  gate?: {                            // kind: "gate" — human checkpoint on Telegram
    timeout: string;                  // ms-style duration, grammar ^\d+(\.\d+)?(m|h|d|w)$ — Zod-enforced. `parseDurationMs` turns it into whole milliseconds with a tiny unit-multiplier table (no `ms` dep); the gate waiter sleeps `${timeoutMs}ms`. No months/years: excludes the M-ambiguity and engine waits cap at ~1y anyway.
    onTimeout: TimeoutAction;
  };
  wait?: {                            // kind: "wait" — external event, e.g. PR review submitted
    event: string;
    filter?: string;                  // CEL expression, evaluated with @marcbachmann/cel-js (zero-dep, actively maintained) — the same dialect as Inngest `if` expressions, so short waits pass the filter through to waitForEvent's `if` verbatim and parked waits evaluate it locally
    timeout: string;                  // same duration grammar as gate.timeout
    onTimeout: TimeoutAction;
  };
  loop?: {                            // optional back-edge: "address comments, repeat"
    backTo: string;                   // earlier stage id
    until: string;                    // prose condition an LLM step evaluates ("all review threads resolved")
    maxIterations: number;            // hard code-owned cap; the LLM cannot extend it
  };
}

// Every timeout resolves to a terminating action — "remind" re-arms the deadline and notifies
// at most maxReminders times, then falls through to a terminal action. No unbounded waits.
// The ~1-year park ceiling bounds the checkpoint's TOTAL effective park — timeout ×
// (maxReminders + 1), not per re-arm — so "no parked run older than a year" holds as a global
// invariant the ticker and cleanup can rely on. Zero-duration timeouts are rejected.
type TimeoutAction =
  | { kind: "proceed" }
  | { kind: "abort" }
  | { kind: "remind"; maxReminders: number; finalAction: "proceed" | "abort" };

// Built-in artifact kinds are the shapes the orchestrator can act on deterministically
// (safe-outputs). "json" carries a compiler-emitted JSON Schema validated structurally at
// run time — user-shaped handoffs need no Cogmo code change, keeping the Purpose promise.
type StageOutput =
  | { kind: "plan" }
  | { kind: "pr_metadata" }
  | { kind: "text" }
  | { kind: "json"; schema: JsonSchema };
```

Compiler hardening (n8n's lesson): the LLM never emits the definition as freeform JSON to be trusted — it goes through Zod structured output with retry + feedback, then a deterministic validation pass (stage ids unique, `loop.backTo` references an earlier stage, loop scopes neither nest nor cross — back-edge ranges are disjoint, `instructions` present on `agentic`/`gate` stages, tool globs resolve, trigger source exists, every gate/wait has a timeout with a terminating action). Validation failures feed back into the retry loop; persistent failure surfaces to the user as "I couldn't compile this — here's what's ambiguous."

## Definition Lifecycle `[proposed]`

1. **Author.** User describes the pipeline in free text on any channel (or edits an existing definition's source text).
2. **Compile.** Typed LLM contract produces a candidate `PipelineDefinition`.
3. **Preview.** Cogmo echoes the compiled pipeline as a readable stage list — trigger, numbered stages, gates bolded, loop bounds explicit:
   > Trigger: you say "start the issue pipeline".
   > 1. Gather context — read the issue and the code around it.
   > 2. Draft a plan → **gate: your approval, 3d timeout, reminds ×3 then aborts**.
   > 3. Implement (coding delegation) → open PR.
   > 4. Wait for review comments (14d timeout) → address them → back to 4, max 5 rounds.
4. **Confirm.** Explicit user approval activates the definition. The preview *is* the contract — no hidden prompts (gh-aw's trust lesson).
5. **Version.** `pipeline_definitions` rows are immutable in every column except `active` (fits the prefer-immutable-rows rule — `active` is a status transition, like `coding_tasks.status`). Activation flips the old version off and the new one on in a single tx, deactivate-then-activate so the partial unique index holds throughout. The original free text is stored alongside the compiled JSON as the editable source. Editing recompiles into a new version; **in-flight runs keep the version they started with** (Temporal's stance — the only safe choice given week-long waits). New runs use the latest active version.

## Execution Model `[confirmed]`

**DB-backed run state + one short Inngest function per stage transition, chained by events** — not one long-lived durable function per run.

| Why not one big function with waits | |
|-|-|
| Mid-flight code/definition drift | Inngest versioning is fail-soft: step-ID memoization, warnings not errors. A run sleeping a week inside one function while Cogmo redeploys risks silent drift. Stage boundaries as event seams make every deploy safe. |
| Unbounded review loops | Each loop iteration consumes steps from a single 1000-step budget; event-chained stages give every stage its own budget. |
| Observability & admin | `pipeline_runs.current_stage` is queryable for `/status` and the web UI without going through Inngest's API. |
| Fit | Matches the event-decoupling philosophy and the immutable-rows rule. |

Shape:

- `pipeline_runs` row is the source of truth: definition version FK, current stage, per-stage typed outputs, loop counters, status.
- A generic `pipeline-stage-runner` Inngest function is triggered by `pipeline/stage.due { runId, stageId, iteration }`. It loads the run + pinned definition, executes the stage, persists the typed output and transition in one tx inside a `step.run`, then emits the next `pipeline/stage.due` via a separate `step.sendEvent`. On the last stage, `advance-run` calls `completeRun` and a `notify-completed` notice follows. Persist and emit are separate steps, as in coding delegation's `emit-cli-done`, so a retry after the commit replays only the emit, never the transition. If the transition step itself re-runs after its commit, it finds the run already at its target and re-sends the follow-up event (deduped on the run cursor) rather than stopping. The store reports the run's cursor from the same locked read that decided `stale`, so the step decides without a second read. Stage-internal work uses normal `step.run` durability.
- **Gates park in the DB.** A `gate` stage sets `status = 'waiting_gate'` and emits `pipeline/gate.pending`. The channel adapter posts Approve / Cancel buttons carrying the run id and an 8-hex token of the gate key `${runId}:${stageId}:${iteration}`, so a leftover button from an earlier gate is refused. `pipeline-gate-waiter` sleeps `reminders + 1` times, one sleep before each reminder and one more, then emits `pipeline/gate.resolved`. A tap emits the same event, with no bus-dedup id. `pipeline-gate-resolver` applies it in one step. Its locked flip out of `waiting_gate` records `gate_resolution`: the gate key and the resolver's Inngest run id. One resolution wins; the others read `stale`. A stale outcome whose claim is its own is a post-commit re-run: it re-sends the next stage and notice while the run hasn't moved. Otherwise it stays silent, except that a losing tap is told. Every outcome but `not_found` emits `pipeline/gate.settled` after the commit, which cancels the waiter. If resolution fails for good, `onFailure` runs `inspectFailedResolution` under the failed run's id; it checks the park and fails a timed-out run in one transaction, so a tap landing in between is never failed. Still parked: a tap is told the checkpoint resolves on its timeout, and a timeout fails the run. Moved on: it sends the follow-ups the stale path would (`sendFollowUps`). Only the waiter stays in flight across a deploy, like coding plan approval, which parks at `awaiting_approval` and resumes in a separate function.
- Every gate is **bounded**: timeout + declared default action, slept out by `pipeline-gate-waiter`.
- **Waits and admission `[proposed]`** (slice 3). Multi-day `wait` stages park in the DB with a `wait_key` correlation column, resumed when the matching inbound event arrives. Their `wait_deadline` fires via the existing 1-minute ticker (same `FOR UPDATE SKIP LOCKED` scan as `scheduled_tasks`). One run at a time per definition by default (`max_concurrent_runs = 1`), in the admission-control spirit of [coding-delegation.md](coding-delegation.md) → Admission & Rate Limiting.

### Stage kinds

| Kind | Executes as | Notes |
|-|-|-|
| `agentic` | Agent-loop turn with the stage's `instructions`, tool allowlist, and prior-stage outputs in context. Coding delegation as a stage is slice 4 `[proposed]` | A declared `json` output comes from a tools-free prompted call validated with Ajv |
| `gate` | Telegram message + inline keyboard (Approve / Cancel) on the run's conversation | A tap emits `pipeline/gate.resolved`; the resolver then emits `pipeline/stage.due`. Revise — re-running the prior stage with the user's feedback — is itself a back-edge, so it arrives with loop execution |
| `wait` `[proposed]` | DB-parked wait on an external event | e.g. `github/pr.review_submitted` filtered to the run's PR |

### Starting a run and running a stage `[confirmed]`

- **Start.** `start_pipeline(name)` pins the active definition version and refuses, with the list, any envelope using features the engine can't run yet (non-command triggers, `wait` stages, loops, `plan` / `pr_metadata` artifacts) — so a definition can compile, preview and activate before it is runnable. A pipeline with gates also needs a reachable channel whose adapter posts gate keyboards (`AdapterModule.pipelineGates`; Telegram today). It creates the run's own conversation, routes the user's reachable channel sessions onto it (the same rotation a scheduled fire performs), opens the run on its first stage, and emits `pipeline/stage.due`, carrying the starting chat conversation so the first stage waits (up to 30s) for that turn's `response/ready` before streaming into the same chat. The tool is durable and keyed: the run row carries the call's idempotency key, and a retry looks the run up before anything else — the active version may have changed since — and resumes it against its pinned definition, re-sending the first stage under its bus-dedup id.
- **Agentic stage.** The stage runner executes the stage as an agent turn built from the primitives `handle-message` composes, under stage policy. The stage's prose and earlier artifacts become the user message. It is persisted as a `source='pipeline'` inbound keyed `pipeline:<runId>:<stageId>:<iteration>`, whose id is the messages' cursor and the loop's `turnKey`. The stage allowlist narrows the profile's composed tools. Output streams by broadcast to every session on the run conversation.
- **Cursor isolation.** `getUnbatchedInbound` skips `source='pipeline'` inbounds, and `getLastAssistantMessage` skips assistant rows cursored on one. Chat input sent around a stage is neither dropped as already answered nor batched with the stage prompt.
- **JSON artifacts.** A `json` output schema must be a top-level `"type": "object"`, checked at definition and at run time. The artifact comes from a tools-free call with the schema in the prompt, since provider strict modes reject ordinary schemas. Ajv validates it through the compile path the definition check uses (drafts 07, 2019-09 and 2020-12; draft-06 against its meta-schema on the draft-07 class; see `output-schema.ts`; `format` is advisory). A failing result gets one retry with the errors fed back.
- **Handoffs.** Earlier artifacts follow the stage's instructions and output contract. They sit in blocks marked as data, with any handoff tag in their content neutralised (text escaped, JSON as `\u003c`). The prompt closes by restating the contract. This mitigates injected text; the stage allowlist is the boundary.
- **Failure.** A degraded loop, a reply cut off at the output cap, or a result that still fails its JSON Schema fails the run with the reason. A degraded turn first retracts the output its dropped iteration streamed (`retract-degraded-output`), as `handle-message` does before its apology; a cut-off reply stays in the transcript and is delivered, but no artifact is extracted from it.
- **Turn serialization.** The stage runner and `handle-message` share one env-scoped concurrency key on the conversation id (`conversationTurnConcurrency`; `pipeline/stage.due` carries the run's `conversationId`). A message sent into the run conversation mid-stage waits for the stage turn, and a stage due while a chat turn is in flight waits for it. The limit counts executing steps, ordered best-effort by run age: a first stage parked in its origin-turn wait frees the slot, and once woken lets a chat turn already in flight finish. A step retried after an error can run between two steps of a younger turn. Both functions must use that one object: Inngest shares the queue only through an identical key expression. A `pipeline/stage.due` without `conversationId` still runs, but isn't guaranteed to queue with chat turns.

### Loops `[proposed]`

The back-edge is code-owned: the runner checks `iteration < maxIterations` and emits `pipeline/stage.due` for `backTo`. Loop scopes are flat — the validation pass rejects nested or crossing back-edges — so the single `iteration` counter on the run suffices; it resets to 0 when the run advances past the loop's back-edge stage (exits the scope). The `until` condition is evaluated by an LLM step (structured `{ done: boolean, reason: string }`), but the LLM cannot raise `maxIterations` — exhausting the cap surfaces to the user as a gate ("5 review rounds done, threads still open — continue?"). Temporal's "deterministic but not predetermined."

### Context handoff

Typed `output` artifacts flow forward (Anthropic's delegation guidance: objective, format, boundaries), **and** the full prior-stage transcripts stay retrievable — each run owns a conversation, stages append to it, so later stages can read everything (Cognition: don't summarize away decisions; actions carry implicit decisions). Within a loop, `stage_outputs` keeps only the latest iteration's artifact per stage (latest-wins, intentional) — earlier iterations' reasoning survives in the run conversation, which is where decision history belongs. For review loops specifically `[proposed]`: same branch, same coding session resumed via `--resume <sid>` — the PR is the durable checkpoint.

## Safety `[proposed]`

- **Per-stage tool allowlists** `[confirmed]` compile into the envelope. `restrictToStage` (`stage-tools.ts`) filters the profile's composed `ToolRegistry` by the stage's globs, so a stage can only narrow what the profile allows. A "gather context" stage gets read tools only. The pipeline tools (`define_pipeline` / `activate_pipeline` / `list_pipelines` / `start_pipeline`) are always removed, and a stage's `Service` carries no `pipelines` namespace. A run must not define, activate or start pipelines; that path always goes through the user-facing preview/confirm gate.
- **Writes as safe-outputs** (gh-aw's flagship pattern, already Cogmo's shape): agentic stages never hold "open PR" / "push" capabilities — they produce artifacts; the orchestrator executes the side effects deterministically, exactly as coding delegation's CLI is told "do NOT open a PR."
- **Risk-rate tools** (read-only / reversible / irreversible — OpenAI's guide). Irreversible tools in a stage allowlist force an implicit gate before that stage unless the user explicitly waived it in the definition (and the preview says so).
- **Budgets**: per-run token/wall-time caps and per-definition daily run quotas, enforced like coding delegation's admission checks. A runaway pipeline pauses with backoff, never silently retries forever.

## Triggers `[proposed]`

One generic surface; sources arrive independently:

| Kind | Mechanism | Status |
|-|-|-|
| `command` | `start_pipeline` agent tool — the model routes the user's request, by phrase or paraphrase, to it; `trigger.phrase` is prose the model matches, not a literal matcher | Shipped (slice 2) |
| `cron` | A `scheduled_tasks` row owned by the definition; the fire handler emits `pipeline/run.requested` instead of a synthetic turn | Rides existing ticker |
| `event` | Inbound external events normalized onto the event bus as `<source>/<entity>.<action>` | Per-source follow-ups |

External event sources are deliberately out of scope here; parked findings for when they're wanted `[research]`:

- **GitHub PR review events** (the "wait for review" stage): webhook through a named Cloudflare Tunnel (production-grade, free, needs a domain) with signature check (`X-Hub-Signature-256`, constant-time compare), **plus** an ETag reconciliation poller — GitHub does not retry failed deliveries. Pure polling is also viable at personal scale: conditional requests returning 304 are rate-limit-free; 5k req/hr budget dwarfs a handful of open PRs at 60s cadence. Avoid the Events API (30s–6h latency). Relevant webhook events: `pull_request_review` (submitted), `pull_request_review_comment`, `issue_comment` (PR conversation), `pull_request` (`synchronize`, `closed` + `merged: true`).
- **Linear**: personal API key + UI-created webhook (workspace admin) covers issue/comment triggers — no OAuth app needed. The Agents API (sessions, activities, @-mention UX) requires an `actor=app` OAuth installation; only worth it if Cogmo should appear as a delegable agent inside Linear.

## Data Model `[confirmed]`

```sql
CREATE TYPE pipeline_run_status AS ENUM (
  'queued', 'running', 'waiting_gate', 'waiting_event', 'completed', 'failed', 'cancelled'
);
-- 'queued' (admission control) and 'waiting_event' (wait stages) are declared for slice 3 and unused.

pipeline_definitions (
  id            UUID v7 PK,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  version       INT NOT NULL,                   -- UNIQUE(user_id, name, version); all columns except active are immutable
  source_text   TEXT NOT NULL,                  -- the user's free text — the editable source
  compiled      JSONB NOT NULL,                 -- PipelineDefinitionSchema (jsonbZod)
  active        BOOLEAN NOT NULL,               -- partial unique index (user_id, name) WHERE active enforces one active version
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)

pipeline_runs (
  id                 UUID v7 PK,
  definition_id      UUID NOT NULL REFERENCES pipeline_definitions(id),  -- pins the version
  conversation_id    UUID NOT NULL REFERENCES conversations(id),  -- the run's thread; gates and progress land here (ON DELETE no-action — conversations are not pruned)
  status             pipeline_run_status NOT NULL,
  current_stage      TEXT NOT NULL,             -- stage id from the pinned definition
  iteration          INT NOT NULL,              -- loop counter for current_stage's loop scope; 0 until loops land
  stage_outputs      JSONB NOT NULL,            -- StageOutputsSchema: stageId → typed artifact; latest loop iteration wins (see Context handoff)
  failure_reason     TEXT,
  gate_resolution    JSONB,                     -- GateResolutionSchema: { gateKey, resolverRunId } of the resolution that claimed the latest gate; null until one does
  idempotency_key    TEXT UNIQUE,               -- the start_pipeline tool call's key, so a retried call recovers its run; null when opened outside a retrying context
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

`[proposed]` Wait stages (slice 3) add `wait_key TEXT` (correlation key, with a partial index `WHERE status = 'waiting_event'` for event-resume lookups) and `wait_deadline TIMESTAMPTZ` (the ticker applies `onTimeout` once it passes). A gate's deadline lives in its waiter's `step.sleep`, so gates need neither column.

No `user_id` on `pipeline_runs`, deliberately. Every run load also fetches the pinned definition (the stages live in its `compiled` blob), and that row carries `user_id`. The run lookups (by id, and by `idempotency_key` on a retried start) are not user-keyed, and the proposed wait-stage lookups and admission quotas aren't either. Denormalize only if a user-keyed hot path materializes.

Owned by the `agent/pipeline/` domain folder (pipelines are agent work items, like `coding_tasks`). Listed in [data-model.md](data-model.md) → Table Index.

## Relationship to Existing Concepts `[proposed]`

| Concept | Relationship |
|-|-|
| Coding delegation | First built-in pipeline. Near-term it stays as-is; an `agentic` stage can *invoke* it (goal in, PR metadata out). Re-expressing its orchestrators as a built-in `PipelineDefinition` is a later refactor, attempted only once user-defined pipelines prove the model. |
| `scheduled_tasks` | Cron triggers ride it `[proposed]`. `start_pipeline` routes sessions onto the run's conversation with the same rotation a scheduled fire performs. |
| Skills | Orthogonal: a skill is a capability inside a stage; a pipeline is the spine across stages. A stage's tool allowlist can include skills. |
| Steering rules | Apply per-profile as usual inside `agentic` stages; pipeline definitions are not steering rules (different lifecycle: versioned artifacts vs. accumulated guidance). |
| Evolution | Stage-1 corrections during pipeline runs graduate into steering rules normally. A later evolution stage could propose pipeline edits — gated like code changes, since a definition is executable configuration. |

## Implementation Plan `[confirmed]`

Phased as **PROGRESS.md → Phase 8**, four slices mirroring coding delegation's thin-slice precedent: (1) definitions spine — compile → preview → activate, no execution, plus the compile-quality eval set; (2) run engine MVP — command trigger, linear `agentic`/`gate` stages; (3) loops, DB-parked waits, cron triggers, admission control; (4) integration breadth — coding delegation as a stage, first external event source. The only new runtime dependency is `@marcbachmann/cel-js`, deferred to slice 3. Durations use the ms-style grammar above (decision: legibility in previews beat ISO-8601's standardness; the Zod regex removes ms-style's ambiguity, and `parseDurationMs` converts to milliseconds for `step.sleep`).

## Open Questions

- Compiler model/prompt: how much pipeline-design knowledge (gate placement, loop bounds) does the compile contract encode vs. ask the user about during preview?
- Revise-at-gate semantics: does "Revise" at a gate re-run the prior stage with feedback (cheap) or allow editing the remaining pipeline mid-run (powerful, but mutates a pinned version)? Slice 2 ships Approve / Cancel only; the question reopens with back-edges.
- Where event-source normalization lives (`src/transport/` adapter vs. a new `src/events/` edge) once the first external webhook/poller source lands.
- Whether a stage should ever be able to ask the user something. An `agentic` stage is one turn, which is what makes termination structural — the turn ends, the stage ends. A stage that converses would end on an explicit tool call instead, and would need a turn budget to stay bounded. A gate placed *before* a stage covers much of the same ground (ask, approve, then run) without giving that up. See todo.md → User-defined pipelines.

## Sources `[research]`

gh-aw: <https://github.github.com/gh-aw/> · <https://githubnext.com/projects/agentic-workflows/> — Anthropic: <https://www.anthropic.com/engineering/building-effective-agents> · <https://www.anthropic.com/engineering/multi-agent-research-system> — OpenAI: <https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf> · <https://developers.openai.com/api/docs/deprecations> — Devin: <https://docs.devin.ai/product-guides/creating-playbooks> · <https://cognition.ai/blog/dont-build-multi-agents> — Copilot: <https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent> — Inngest: <https://www.inngest.com/docs/learn/versioning> · <https://www.inngest.com/docs/usage-limits/inngest> · <https://www.inngest.com/docs/reference/functions/step-wait-for-event> · <https://agentkit.inngest.com/advanced-patterns/human-in-the-loop> — Temporal: <https://temporal.io/blog/very-long-running-workflows> · <https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning> — Restate: <https://www.restate.dev/blog/solving-durable-executions-immutability-problem> — 12-factor agents: <https://github.com/humanlayer/12-factor-agents> — n8n: <https://docs.n8n.io/advanced-ai/ai-workflow-builder/> — StateFlow: <https://arxiv.org/html/2403.11322v1> — Linear: <https://linear.app/developers/webhooks> · <https://linear.app/developers/agents> — GitHub webhooks: <https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks> · <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
