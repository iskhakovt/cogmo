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
    timeout: string;                  // ms-style duration, grammar ^\d+(\.\d+)?(m|h|d|w)$ — Zod-enforced. Parsed to a deadline with a tiny unit-multiplier table (no `ms` dep). No months/years: excludes the M-ambiguity and engine waits cap at ~1y anyway.
    onTimeout: TimeoutAction;
  };
  wait?: {                            // kind: "wait" — external event, e.g. PR review submitted
    event: string;
    filter?: string;                  // CEL expression, evaluated with @marcbachmann/cel-js (zero-dep, actively maintained) — the same dialect as Inngest `if` expressions, evaluated locally against the parked run's resume event
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
   > 1. Gather context — chat with you until I have enough.
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
| Fit | Matches the event-decoupling philosophy, the immutable-rows rule, and the proven `scheduled_tasks` ticker pattern ([scheduling.md](scheduling.md)). |

Shape:

- `pipeline_runs` row is the source of truth: definition version FK, current stage, per-stage typed outputs, loop counters, status.
- Three short functions, each entered by an event and each ending promptly. `pipeline-stage-runner` (`pipeline/stage.due { runId, stageId, iteration, note? }`) *enters* a stage; `pipeline-stage-advance` (`pipeline/stage.completed`) records a finished stage's artifact and moves the cursor; `pipeline-gate-resolve` (`pipeline/gate.resolved`) applies the user's decision at a gate. The two that move the run persist the transition in one tx inside a `step.run` and emit the follow-on event from a separate `step.sendEvent` — the same persist/emit split as coding delegation's `emit-cli-done`, so a retry after the commit replays only the emit, never the transition.
- **Nothing parks inside a function — not even a short gate.** A gate flips the run to `waiting_gate`, posts its prompt, and the invocation ends; the user's decision arrives later as its own event. This is the shape coding delegation already uses for plan approval (the plan orchestrator ends at `awaiting_approval`; the Telegram callback emits `coding/task/plan-approved`, which triggers the execute orchestrator), and it keeps a week-long gate free of in-flight state across deploys. `step.waitForEvent` appears nowhere in the engine.
- **The cursor is `(current_stage, iteration)`, and the event is only a request.** Every function re-reads the run and refuses to act when the event no longer matches — that is what makes a redelivery, a superseded revise, or a decision racing a cancellation a no-op instead of a second entry into a stage. `iteration` is a monotonic pass counter: forward moves carry it unchanged, a backward move (a gate's revise; loop back-edges in slice 3) increments it, which is what keeps each entry's idempotency keys distinct.
- Every gate/wait is **bounded**: timeout + declared default action. Timeouts fire via the existing 1-minute ticker (same `FOR UPDATE SKIP LOCKED` scan shape as `scheduled_tasks`). *Not yet enforced* — a compiled `gate.timeout` / `onTimeout` is stored and previewed but nothing acts on it until slice 3's ticker lands, so today a gate waits for the user indefinitely.
- **A run supervises a conversation.** The run's conversation is where its stages happen, which is why at most one live run per conversation is a DB invariant (partial unique index on the non-terminal statuses) rather than a convention. A command-triggered run reuses the conversation the user asked from; cron triggers, which have no such conversation, will reuse the scheduled-fire dispatch that already rotates channels onto a fresh one.
- One run at a time per definition by default (`max_concurrent_runs = 1`), same admission-control spirit as [coding-delegation.md](coding-delegation.md) → Admission & Rate Limiting.

### Stage kinds

| Kind | Executes as | Notes |
|-|-|-|
| `agentic` | Ordinary conversation turns. The runner persists the stage's instructions and prior artifacts as a synthetic inbound (the `source = 'pipeline'` sibling of a scheduled fire) and ends; `handle-message` runs the turn with the stage's tool allowlist in force. The stage stays open across as many turns as the work takes — "chat with me until I have enough" is a stage, not a workaround | Ends when the model calls `complete_stage` with the declared artifact — an explicit handoff, not "a turn finished" |
| `gate` | Prompt delivered to every session, plus an Approve / Revise / Cancel inline keyboard on channels that render one. The run parks at `waiting_gate`; back-and-forth in the conversation carries on as normal turns | Resolved only by the user, through `Transport.pipelines.resolveGate` — a keyboard tap or `/gate approve\|revise [feedback]\|cancel`. No model sits between their decision and the transition |
| `wait` | DB-parked wait on an external event | e.g. `github/pr.review_submitted` filtered to the run's PR. Slice 3 |

**Why the model, not the turn boundary, ends a stage.** A stage that ended when its first turn ended could not ask the user a question, and the engine would be inferring completion from a signal that means nothing. `complete_stage` is built per turn from the pinned definition, so its schema *is* the stage's declared output: `text` takes the text, `json` is validated against the compiler-emitted JSON Schema with violations handed back to the model to correct, a stage with no declared output takes a summary and stores nothing. The tool is the stage's only exit and the only pipeline tool a stage ever gets.

### Loops

The back-edge is code-owned: the runner checks `iteration < maxIterations` and emits `pipeline/stage.due` for `backTo`. Loop scopes are flat — the validation pass rejects nested or crossing back-edges — so the single `iteration` counter on the run suffices; it resets to 0 when the run advances past the loop's back-edge stage (exits the scope). The `until` condition is evaluated by an LLM step (structured `{ done: boolean, reason: string }`), but the LLM cannot raise `maxIterations` — exhausting the cap surfaces to the user as a gate ("5 review rounds done, threads still open — continue?"). Temporal's "deterministic but not predetermined."

### Context handoff

Typed `output` artifacts flow forward (Anthropic's delegation guidance: objective, format, boundaries), **and** the full prior-stage transcripts stay retrievable — each run owns a conversation, stages append to it, so later stages can read everything (Cognition: don't summarize away decisions; actions carry implicit decisions). Within a loop, `stage_outputs` keeps only the latest iteration's artifact per stage (latest-wins, intentional) — earlier iterations' reasoning survives in the run conversation, which is where decision history belongs. For review loops specifically: same branch, same coding session resumed via `--resume <sid>` — the PR is the durable checkpoint.

## Safety `[confirmed]`

- **Per-stage tool allowlists** compile into the envelope and resolve at *turn-build* time, not only at compile time: the stage's globs filter the tools the profile composed for that turn, so a stage can only ever narrow what the profile already permits. Resolving late is the point — the profile's toolset, the installed skills and the approved MCP tools all move between compiling a definition and running it, and least privilege is a property of the call that actually happens. A stage that declares no `tools` inherits the profile's set (the compiler omits the field for stages that are pure conversation); one whose globs match nothing keeps `complete_stage` alone, so it can still finish but cannot act. The pipeline tools themselves (`define_pipeline` / `activate_pipeline` / `start_pipeline` / `list_pipelines`) are denied whatever a stage declared — a run must not define, activate or start pipelines mid-run; that self-modification path always goes through the user-facing preview/confirm gate.
- **Writes as safe-outputs** (gh-aw's flagship pattern, already Cogmo's shape): agentic stages never hold "open PR" / "push" capabilities — they produce artifacts; the orchestrator executes the side effects deterministically, exactly as coding delegation's CLI is told "do NOT open a PR."
- **Risk-rate tools** (read-only / reversible / irreversible — OpenAI's guide). Irreversible tools in a stage allowlist force an implicit gate before that stage unless the user explicitly waived it in the definition (and the preview says so).
- **Budgets**: per-run token/wall-time caps and per-definition daily run quotas, enforced like coding delegation's admission checks. A runaway pipeline pauses with backoff, never silently retries forever.

## Triggers `[proposed]`

One generic surface; sources arrive independently:

| Kind | Mechanism | Status |
|-|-|-|
| `command` | The user asks; the agent calls `start_pipeline`, which opens the run and emits the first `pipeline/stage.due` | Shipped in slice 2 — the tool route, not phrase matching (see Open Questions) |
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
-- 'queued' = admitted-pending behind max_concurrent_runs, same naming convention as coding_task_status.

pipeline_definitions (
  id            UUID v7 PK,
  user_id       UUID NOT NULL,                  -- multi-user from day 1, like scheduled_tasks
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
  iteration          INT NOT NULL,              -- loop counter for current_stage's loop scope
  stage_outputs      JSONB NOT NULL,            -- StageOutputsSchema: stageId → typed artifact; latest loop iteration wins (see Context handoff)
  wait_key           TEXT,                      -- slice 3. correlation key; partial index WHERE status='waiting_event' serves event-resume lookups
  wait_deadline      TIMESTAMPTZ,               -- slice 3. ticker fires onTimeout when passed
  failure_reason     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  -- UNIQUE (conversation_id) WHERE status NOT IN ('completed','failed','cancelled')
  -- one live run per conversation: the run supervises that conversation's turns,
  -- so a second cursor over the same thread is not a state the engine can hold.
)
```

A stage's instructions reach the agent as an `inbound_messages` row with `source = 'pipeline'` and `pipeline_stage_key = '<runId>:<stageId>:<iteration>'` — the same synthetic-inbound shape scheduled fires use, with its own idempotency key so a replayed dispatch reuses the row instead of posting the stage to the user twice.

No `user_id` on `pipeline_runs` — deliberate: every run load also fetches the pinned definition (the stages live in its `compiled` blob), and that row carries `user_id`, so the join is free on every path that needs it. The hot run lookups — `wait_key` event-resume, `wait_deadline` ticker scan — are not user-keyed, and admission quotas count per definition. Denormalize only if a user-keyed hot path materializes.

Owned by a new `agent/pipeline/` domain folder (pipelines are agent work items, like `coding_tasks`). Listed in [data-model.md](data-model.md) → Deferred Tables.

## Relationship to Existing Concepts `[proposed]`

| Concept | Relationship |
|-|-|
| Coding delegation | First built-in pipeline. Near-term it stays as-is; an `agentic` stage can *invoke* it (goal in, PR metadata out). Re-expressing its orchestrators as a built-in `PipelineDefinition` is a later refactor, attempted only once user-defined pipelines prove the model. |
| `scheduled_tasks` | Cron triggers ride it; the DB-park + ticker timeout pattern is borrowed from it. |
| Skills | Orthogonal: a skill is a capability inside a stage; a pipeline is the spine across stages. A stage's tool allowlist can include skills. |
| Steering rules | Apply per-profile as usual inside `agentic` stages; pipeline definitions are not steering rules (different lifecycle: versioned artifacts vs. accumulated guidance). |
| Evolution | Stage-1 corrections during pipeline runs graduate into steering rules normally. A later evolution stage could propose pipeline edits — gated like code changes, since a definition is executable configuration. |

## Implementation Plan `[confirmed]`

Phased as **PROGRESS.md → Phase 8**, four slices mirroring coding delegation's thin-slice precedent: (1) definitions spine — compile → preview → activate, no execution, plus the compile-quality eval set *(shipped)*; (2) run engine MVP — command trigger, linear `agentic`/`gate` stages *(shipped; a definition carrying a loop, a `wait` stage, or a `plan`/`pr_metadata` artifact is refused at run start rather than run wrongly)*; (3) loops, DB-parked waits, cron triggers, admission control; (4) integration breadth — coding delegation as a stage, first external event source. The only new runtime dependency is `@marcbachmann/cel-js`, deferred to slice 3. Durations use the ms-style grammar above (decision: legibility in previews beat ISO-8601's standardness; the Zod regex removes ms-style's ambiguity).

## Open Questions

- Compiler model/prompt: how much pipeline-design knowledge (gate placement, loop bounds) does the compile contract encode vs. ask the user about during preview?
- Where event-source normalization lives (`src/transport/` adapter vs. a new `src/events/` edge) once the first external webhook/poller source lands.
- **Stage stall.** Nothing bounds an `agentic` stage that the model never completes. It is not a runaway — no turn fires until the user speaks, and the stalled stage is visible in the conversation — so slice 2 ships without a cap. If it bites, the fix is a per-stage turn budget checked where the turn already loads its stage.

Settled since:

- *Revise-at-gate* re-runs the stage before the gate with the user's feedback as its note, at the next iteration. Editing the remaining pipeline mid-run would mutate a pinned version, which is exactly what pinning exists to prevent.
- *`command` triggers* go through the `start_pipeline` tool rather than phrase matching. The compiled `trigger.phrase` stays as documentation of the user's intent and as the preview's wording; the agent decides when the user is asking for it.

## Sources `[research]`

gh-aw: <https://github.github.com/gh-aw/> · <https://githubnext.com/projects/agentic-workflows/> — Anthropic: <https://www.anthropic.com/engineering/building-effective-agents> · <https://www.anthropic.com/engineering/multi-agent-research-system> — OpenAI: <https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf> · <https://developers.openai.com/api/docs/deprecations> — Devin: <https://docs.devin.ai/product-guides/creating-playbooks> · <https://cognition.ai/blog/dont-build-multi-agents> — Copilot: <https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent> — Inngest: <https://www.inngest.com/docs/learn/versioning> · <https://www.inngest.com/docs/usage-limits/inngest> · <https://www.inngest.com/docs/reference/functions/step-wait-for-event> · <https://agentkit.inngest.com/advanced-patterns/human-in-the-loop> — Temporal: <https://temporal.io/blog/very-long-running-workflows> · <https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning> — Restate: <https://www.restate.dev/blog/solving-durable-executions-immutability-problem> — 12-factor agents: <https://github.com/humanlayer/12-factor-agents> — n8n: <https://docs.n8n.io/advanced-ai/ai-workflow-builder/> — StateFlow: <https://arxiv.org/html/2403.11322v1> — Linear: <https://linear.app/developers/webhooks> · <https://linear.app/developers/agents> — GitHub webhooks: <https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks> · <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
