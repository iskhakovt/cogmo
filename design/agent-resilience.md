# Agent Resilience `[confirmed]`

How the agent loop handles **LLM provider misbehavior** — empty assistant turns, malformed tool arguments, truncated structured output, refusals where a tool call was required.

Distinct from [crash-recovery.md](crash-recovery.md), which covers Inngest durability (process death, step replay, exactly-once side effects). That doc answers *we lost the worker*; this one answers *the model returned something we can't use*.

## Failure taxonomy `[confirmed]`

Every provider failure falls into one of four classes. The class determines the response.

| Class | Examples | Response |
|-|-|-|
| **A. Transport / infra** | DNS/TLS timeout, 408, 425, 429, any 5xx, mid-stream socket reset before first event | Provider chain (`FallbackLlmProvider`) tries the next candidate. Inngest `retries: 2` retries the whole turn if the chain exhausts. |
| **B. Provider-permanent** | 4xx auth/quota, model deprecated, malformed tool schema (ours), `ProviderConfigError` | `NonRetriableError`. `onFailure` emits `conversation/errored`. `recover-conversation` writes a `cooldown_state` blob on the conversation (see [Auto-repair](#auto-repair-proposed)). New inbounds get an in-cooldown reply until the cooldown elapses or a clear-trigger command (`/repair`, `/model`, `/profile`) runs. |
| **C. Model misbehavior, recoverable** | Empty `content` + `end_turn`, truncated tool-arg JSON, schema-invalid `chatTyped` output, model refusal (`stop_reason: "refusal"` / `finish_reason: "content_filter"` / 400 with content-policy class) | **In-loop per-subtype repair budgets** (most subtypes: 1; refusal: 0, immediate degrade). On exhaustion: degraded reply, conversation stays `active`. |
| **D. Loop pathology** | N consecutive turns producing the same tool calls with no successful side effect; iteration cap hit | Progress fingerprint trips → degraded reply, conversation stays `active`. |

Class A and B are provider-layer concerns and live in `FallbackLlmProvider` + `resolveOrFail`. This doc covers C and D.

## Off-ramps `[confirmed]`

A turn ends in one of three states. Each is a durable signal downstream consumers (evolution failure-reflector, telemetry) can subscribe to.

| Off-ramp | Event | Trigger |
|-|-|-|
| Normal | `response/ready` | Turn produced a usable assistant reply |
| Degraded | `conversation/degraded` | Class C repair budget exhausted, or Class D fingerprint tripped. User sees a system-generated apology; can retry. |
| Errored | `conversation/errored` | Class B failure, Inngest function retries exhausted on Class A, history-invariant violation, programmer-bug exception. Enters auto-repair cooldown — see [Auto-repair](#auto-repair-proposed). |

The Errored off-ramp is the conversation-level circuit breaker: it sets an exponentially-backing-off cooldown that holds off new turns until either the cooldown elapses or an explicit clear-trigger command runs. `degraded` is a soft recovery for "the model wouldn't cooperate" — conversation continues. Class C never escalates to Errored — repeated Class C exhaustion on the same conversation produces repeated `degraded` events, each carrying its subtype tag for telemetry.

**Both Degraded and Errored are events, not statuses.** The conversation row carries no failure-state enum. "The last turn was degraded" lives in the `conversation/degraded` event stream; "this conversation is currently cooling down after an error" is a derived predicate on a JSONB `cooldown_state` column (see [Auto-repair](#auto-repair-proposed)). No major agent framework introduces failure-state enum values on the conversation (OpenAI Threads keep thread-level state binary with run-level status enums; Letta tracks per-step `stop_reason`; CrewAI / AutoGen rely on event signals only). A status enum value wouldn't intrinsically gate anything an event-driven predicate doesn't — it would be net new complexity with two sources of truth to keep in sync.

## Auto-repair `[proposed]`

Inbounds to a conversation that just took the Errored off-ramp wait through an exponentially-backing-off cooldown before the next turn fires, rather than blocking until a human resets the row. Maps to the canonical circuit breaker pattern (`CLOSED` / `OPEN` / `HALF-OPEN`) at the conversation level, collapsed to two persistent states because there's no concurrent traffic to gate.

### State machine `[confirmed]`

| State | Predicate | Behavior |
|-|-|-|
| **Closed** | `cooldown_state IS NULL` | Normal operation. Every inbound runs `handle-message`. |
| **Open** | `cooldown_state IS NOT NULL AND now() < lastErroredAt + cooldownSeconds` | Inbound emits a terse reply with a retry-time estimate. `handle-message` returns `{ status: "skipped", reason: "cooldown" }` without invoking the LLM. |
| (Half-open) | `cooldown_state IS NOT NULL AND now() >= lastErroredAt + cooldownSeconds` | Implicit — the next inbound IS the probe. Entry guard does **not** skip; full `handle-message` runs as a normal turn. Success clears `cooldown_state` to `NULL`; failure routes back through `onFailure` → `recover-conversation` which doubles `cooldownSeconds` (capped at 3600s) and resets `lastErroredAt`. |

Standard three-state circuit breakers reserve `HALF-OPEN` to gate concurrent probes ("send one request, see if it works, before opening the floodgates"). At single-user scale there's no concurrent traffic to gate — the next inbound IS the probe. Collapsing to two persistent states is a deliberate simplification, not an oversight.

### Cooldown curve `[confirmed]`

- **Base:** 60 seconds. Sub-minute backoffs belong inside Inngest's per-step retry budget, not the conversation layer.
- **Multiplier:** 2× per consecutive failure.
- **Cap:** 3600 seconds (1 hour). Past an hour the user has either fixed something themselves or moved on; longer cooldowns don't buy more recovery.
- **Reset:** Any successful turn clears `cooldown_state` to `NULL`. The next failure starts the curve over at 60s, not where it left off.
- **No jitter.** Industry guidance adds jitter to anti-correlate retries across a fleet; at single-user scale there's no fleet.

Sequence: `60s → 120s → 240s → 480s → 960s → 1920s → 3600s` (capped). Seven consecutive failures reach the cap in ~2.5 hours of accumulated wait.

Defaults align with LiteLLM Router's `cooldown_time: 60` and AWS Bedrock retry guidance ("max backoff cap: 10-60s for user-facing operations, longer for background"). Conversation-level cooldown sits between these — LLM responses are user-facing, but the user's tolerance for "I had an error, give me a minute" is measured in minutes, not seconds.

### Storage `[confirmed]`

One JSONB column on `conversations`:

```typescript
const CooldownStateSchema = z.object({
  lastErroredAt: z.string().datetime(),
  cooldownSeconds: z.number().int().positive(),
  consecutiveFailures: z.number().int().positive(),
});

// In conversations schema:
cooldown_state: jsonbZod("cooldown_state", CooldownStateSchema), // nullable
```

Validated at the store boundary via `jsonbZod(name, CooldownStateSchema)` (see `src/db/helpers.ts`). The Zod schema enforces the all-or-none invariant — all three fields are set together or the column is `NULL`. Same shape as `coding_tasks.worktree_assignment` (the canonical atomic-JSONB precedent called out in [`.claude/rules/architecture-rules.md`](../.claude/rules/architecture-rules.md) → "Group atomic multi-field state in a JSONB blob").

`consecutiveFailures` is stored explicitly rather than derived from `cooldownSeconds`. The naive inverse (`log2(cooldownSeconds / 60) + 1`) collapses to a constant once `cooldownSeconds` hits the 3600s cap — at the 8th, 9th, 10th consecutive failure the formula still says 7. Telemetry surfaces consecutive-failure counts (chronic-failure conversations are the most important signal); accuracy past the cap matters precisely when it's most needed. Cost is ~4 bytes per row.

The existing `conversations.status` enum and column are dropped. `'errored'` was the only value other than `'active'`; once auto-repair lands, no code branches on the enum — "in cooldown" is a derived predicate on `cooldown_state`. A single-value enum is pure noise. Future lifecycle states (`'archived'`, `'paused'`) would add a fresh column with a new enum at that time — not by carrying a vestigial one forward today.

### Triggers `[confirmed]`

Two paths emit `conversation/errored`; one handler writes `cooldown_state`:

1. **`handle-message.onFailure`** — Inngest function failure handler. Fires after Inngest's per-invocation retry budget exhausts (Class A persistence, Class B `NonRetriableError`, history-invariant violation, programmer-bug exception). Emits `conversation/errored` with `id: "errored-${runId}"`.
2. **Worker-death reconcile** — new Inngest function subscribed to the environment-wide `inngest/function.failed` system event (`src/inngest/events.ts` → `inngestFunctionFailed`), filtered to `handle-message`. Mirrors `createCodingTaskReconcile` (`src/agent/coding/reconcile-on-failure.ts`) introduced in PR #267 for `coding-task-start`. Catches the case where the worker dies before `onFailure` can fire. Emits `conversation/errored` with the **same** `id: "errored-${runId}"`. Bus-level dedup ensures `recover-conversation` runs exactly once per `runId` regardless of which path emitted first — same pattern as PR #273's `task-failed-${taskId}` shape.

`recover-conversation` consumes `conversation/errored` and writes `cooldown_state` inside `runInTx` — REPEATABLE READ is the project default (see [.claude/rules/architecture-rules.md](../.claude/rules/architecture-rules.md) → All DB operations use transactions; [.claude/rules/store-pattern.md](../.claude/rules/store-pattern.md) → Default isolation is REPEATABLE READ). The read-modify-write reads the prior blob (if any), increments `consecutiveFailures`, doubles `cooldownSeconds` (or starts at 60s) capped at 3600s, writes the new blob. Snapshot isolation prevents the lost-update race if two `conversation/errored` events somehow slip past bus dedup; the second write either sees the first's commit and bumps from there, or hits a `40001` and retries through the transactor's once-retry budget.

**Half-open failure** — first inbound past the cooldown threshold runs `handle-message`; if it fails again, path 1 applies, the `recover-conversation` handler reads the prior `cooldownSeconds` and doubles it (not starting fresh at 60s).

**Degraded does NOT trigger cooldown.** A degraded reply means the loop produced *something* the user can act on; conversation flow continues. Repeated `degraded` on the same conversation surfaces in telemetry but doesn't escalate. (Telemetry-driven escalation — "5 degrades in 10 min → cooldown" — is a deferred follow-up.)

**`errorClass` on `conversation/errored` is best-effort under bus race.** Both paths emit with the same dedup `id`, so Inngest delivers exactly one event to `recover-conversation` — but *which* one is whichever lands on the bus first. When `onFailure` runs successfully AND the worker exits cleanly, `inngest/function.failed` still fires; if the reconcile's emit arrives first, `recover-conversation` sees `errorClass: "WorkerDeath"` even though the real cause was e.g. `NonRetriableError(BadRequestError)`. Cooldown writes don't branch on `errorClass`, so this is harmless for the circuit-breaker layer. Downstream consumers that DO want to bucket by class (evolution failure-reflector) must cross-check against `runId` in the structured logs — `agent.repair` / `agent.degrade` log lines and Inngest's run metadata carry the authoritative class. Treat `errorClass` as a hint, not a label.

### In-cooldown reply `[confirmed]`

Inbound arriving in the Open state gets a terse system-generated reply rather than a stalled response. Shape:

> I hit an error on the last message and I'm waiting before trying again. Try once more in ~3 minutes.

Rules:

- **Delivered through the same transport path as normal replies** (`response/ready` event → channel adapter). The reply is generated by `handle-message`'s entry guard, not by invoking the LLM.
- **Ephemeral — not persisted to `messages`.** The cooldown reply exists only on the outbound transport; no `assistant` row is written. Persisting it would leave an assistant row with no corresponding user row (inbounds stay unbatched — see below), producing a transcript hole that future-turn retrieval and the failure-reflector would have to special-case. Pairs with the existing ephemeral patterns for synthetic continuation prompts and the in-loop `[Previous conversation summary]` turn. The next successful turn's transcript covers the user's cooldown-era messages with a real LLM-generated response; the canned cooldown text only ever existed in the user's inbox.
- **Retry-time estimate** is the remaining cooldown rounded to a coarse unit (seconds under a minute, minutes under an hour). Stale by the time the user reads it — acceptable: they get an order-of-magnitude, not a stopwatch.
- **One reply per debounce batch.** A burst of user messages during cooldown coalesces through the debouncer into one `inbound/ready` and gets one in-cooldown reply. Subsequent activity (after the debounce idle window) triggers another `inbound/ready` and another reply if still in cooldown — N user-active windows → N replies, not a tight loop.
- **Inbounds are NOT consumed.** The in-cooldown skip path returns `{ status: "skipped", reason: "cooldown" }` before loading inbounds (matching today's `errored` skip-path shape at `handle-message.ts:235`). The inbounds stay unbatched. When cooldown elapses, the next `inbound/ready` loads the entire backlog as one batch — the user's cooldown-era messages get a real response as part of the next successful turn. Pile-up semantic, not consume-and-acknowledge.
- **Model is NOT invoked.** The in-cooldown reply is a hand-built text response; no tokens spent. Cooldown's whole point is to stop burning tokens on something that just failed.

### Clear triggers `[confirmed]`

`cooldown_state` clears (becomes `NULL`) on any of:

- **First successful turn past the cooldown threshold.** Half-open success — the implicit probe path. Cleared in the same transaction that writes the assistant reply.
- **`/model` command.** User switched models — the previous model may have been the failure cause, and the new one gets a clean slate.
- **`/profile` command.** Profile switch is a context change; the new profile has its own provider/tools and may not exhibit the failure.
- **`/repair` command.** Explicit user-initiated clear. Unique among the clear triggers in supporting non-current conversations: `/repair <alias|uuid>` targets a named conversation, `/repair` (no args) targets the current session. The other clear triggers are scoped to the current session.
- **Future `/secrets rotate` command** (when shipped). Provider credentials refreshed — the most likely cause of Class B auth failures.

`/repair` exists today as a `status='errored' → 'active'` flip; auto-repair repurposes its implementation to clear `cooldown_state` while preserving the user-facing contract ("this conversation is stuck — let it try again"). The targeting syntax (current vs. named) and idempotent semantics (clearing an already-clear conversation succeeds with a no-op reply) carry over unchanged.

**`/model` and `/profile` gain a new responsibility.** Today neither command touches conversation failure state — they're context switches that affect the next turn. Under auto-repair they also clear `cooldown_state` as a side effect of the switch, on the rationale that the user has signaled "external state changed, try again with this new context." The model-/profile-switch happens first; the `clearCooldown` call runs in the same transaction so a partial commit can't leave the conversation in a "switched profile but still cooling down" state.

### Telemetry `[proposed]`

Two events emitted as durable Inngest events:

- **`conversation/cooldown/entered`** — fires whenever `cooldown_state` is set or doubled. Payload: `{ conversationId, lastErroredAt, cooldownSeconds, consecutiveFailures, causeClass, runId }` where `causeClass: "A" | "B" | "invariant" | "bug"` matches the [Failure taxonomy](#failure-taxonomy-confirmed) (Class A transient that exhausted Inngest retries, Class B non-retriable, history-invariant violation, programmer-bug exception). Class C and D don't appear — neither triggers cooldown. Subscribers: evolution failure-reflector, future alerting / metrics sinks.
- **`conversation/cooldown/cleared`** — fires on clear. Payload: `{ conversationId, clearedBy: "success" | "model_switch" | "profile_switch" | "user_repair" | "secrets_rotated", elapsedCooldownSeconds }`.

Structured logs at each transition use the per-turn `turnLogger` so `runId` + `conversationId` are bound — matching the existing `agent.repair` / `agent.degrade` shape (see [Telemetry](#telemetry-confirmed)).

### Where this composes `[proposed]`

| Layer | Responsibility |
|-|-|
| **Inngest per-function retries** | `retries: 2`. Catches Class A transients. Already in place. Doesn't touch cooldown. |
| **`handle-message.onFailure`** | Emits `conversation/errored`. Already in place; payload extends with `causeClass` for the reflector. |
| **`recover-conversation`** | Subscribes to `conversation/errored`, reads prior `cooldown_state`, writes new blob with doubled-or-base `cooldownSeconds`, emits `conversation/cooldown/entered`. Replaces today's `setConversationStatus(..., 'errored')` call. |
| **Worker-death reconcile** | New Inngest function subscribed to `inngest/function.failed` filtered to `handle-message`. Writes `cooldown_state` directly when the row's still-`NULL` state proves the worker died before `onFailure` ran. |
| **`handle-message` entry guard** | Reads `cooldown_state`. In Open state, generates the in-cooldown reply via the transport and returns; doesn't invoke the LLM. |
| **Command handlers (`/model`, `/profile`, `/repair`)** | After the state change, call `clearCooldown(conversationId, "model_switch" | "profile_switch" | "user_repair")`. `/repair`'s implementation switches from a `status` enum flip to the `clearCooldown` call; the user-facing command shape (current vs. named target, idempotent on already-clear) is preserved. |

### Non-goals `[proposed]`

| Idea | Why excluded |
|-|-|
| Jitter on cooldown | Anti-thundering-herd measure. Single user, no herd to anti-correlate. |
| Explicit half-open probe state in storage | The next inbound IS the probe at single-user scale; persisting an explicit state adds writes for nothing. |
| Degraded → cooldown escalation | Degraded means the loop produced something usable. Cooldown is for "couldn't produce anything." Escalating one to the other conflates two distinct off-ramps. |
| Per-error-class thresholds (LiteLLM-style `AuthenticationErrorAllowedFails: 1`) | Conversation-level cooldown has a single trigger (`onFailure` fires for any class that escapes the loop). Per-class thresholds live one layer down in the provider resolver — orthogonal concern. |

## Class C: model misbehavior `[confirmed]`

Class C has two handling surfaces. Most callsites are inside the agent loop, where a per-turn repair budget and a degraded-reply off-ramp apply. A few callsites — typed structured-output calls in background jobs, summarization — live outside the loop and use single-call retry-with-feedback instead, with no shared budget. The repair *semantics* (feedback-injection, JSON repair, continuation prompts) are the same; the *budgeting* and *off-ramp* differ. The Pydantic AI split between `tool_retries` (inside the agent loop) and `output_retries` (per-call validation) is the closest external precedent — Instructor's per-call `max_retries` covers the non-loop pattern.

### In-loop repair

#### Classifier

A turn classifier runs at two points inside `runStreamingAgentLoop`:

1. **Post-stream**, after content blocks are reconstructed, before the `hasToolUse` gate. Detects: empty content, truncation mid-`tool_use`, explicit refusal signal from the SDK adapter (see model-refusal subtype below).
2. **Post-`executeToolCalls`**, before appending results. Detects: schema-validation failure on tool args (Zod failed after `tool-input-coercion` and `jsonrepair`).

Classifier returns a discriminated union:

```typescript
type TurnOutcome =
  | { kind: "ok" }
  | { kind: "repair"; subtype: ClassCSubtype; instructions: RepairInstructions }
  | { kind: "degrade"; reason: string };
```

#### Repair budgets

**Per-subtype**, not shared. Each subtype that warrants a retry attempt carries its own counter. The counter is on the turn boundary (one Inngest invocation of `handle-message`). Per-subtype rather than shared because the subtypes have genuinely different failure dynamics — a continuation prompt for empty `end_turn` is a different repair against a different model state than a non-streaming replay for stream truncation; there's no cost reason to make exhausting one shut the other out. This matches Pydantic AI's split between `tool_retries` (per tool) and `output_retries` (per output path); Instructor's single shared `max_retries` is the outlier.

| Subtype | Budget | Notes |
|-|-|-|
| Empty `content` + `end_turn` | 1 | Anthropic's documented recovery is a continuation nudge; succeeds on first try when it works. |
| Stream truncated mid-`tool_use` | 1 | One non-streaming replay attempt. |
| Model refusal | 0 | Refusal is policy, not a transient mistake. Re-prompting the same model is unlikely to change the outcome — go straight to degrade with a refusal-specific message. |
| Truncated / invalid JSON in tool-arg stream | — | `jsonrepair` is a deterministic transform, not a retry. Runs unconditionally before the parse-failure classification fires; doesn't consume a budget entry. |

The repair runs inside the same Inngest invocation. The outer `retries: 2` remains exclusively for Class A. A Class A retry that succeeds gets fresh Class C budgets because each Inngest invocation is logically a new turn from the user's perspective.

**Tool-arg validation feedback is NOT in the Class C budget.** When Zod validation throws inside a tool handler (`tools.ts:83`), the exception is caught at `loop.ts:260-270` and returned as an `is_error: true` `tool_result` — the same channel handler exceptions already use. This is **unbounded per turn**, capped only by `DEFAULT_MAX_ITERATIONS = 20`. Today a turn can self-correct three sequential Zod failures and finish on the fourth iteration; that behavior is preserved. The Class C budget covers only the subtypes that don't have an existing in-loop self-correction channel.

#### Per-subtype repair

| Subtype | Repair |
|-|-|
| Empty `content` + `end_turn` | Append a user turn with a continuation nudge ("Please complete your response."). Per Anthropic's [stop-reason guidance](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), naive same-prompt retry does not help — the continuation prompt is the documented recovery. |
| Truncated / invalid JSON in tool-arg stream | Run `jsonrepair` on the buffered chunks before declaring failure. If repair produces valid JSON, validate against Zod and proceed. If repair fails, the tool_use surfaces as a tool-arg validation failure — which uses the existing unbounded `is_error: true` feedback channel, not a Class C budget entry. |
| Stream truncated mid-`tool_use` (`stop_reason: "max_tokens"` with partial JSON) | Replay non-streaming with the same params. Single-shot token budget often completes where the chunked stream did not. If the replay itself hits a Class A failure, normal Class A handling applies (provider chain → Inngest `retries: 2`); if the replay raises another Class C signal (`ProviderProtocolError` or `RefusalError`), the loop maps it to a `degrade` with the matching subtype rather than letting it surface as `errored` — the documented recovery was attempted and didn't work. The stream-replay budget is consumed regardless of replay outcome. |
| Model refusal | Immediate degrade — no repair attempt. Degraded-reply text is refusal-specific: *"The model declined that request. Try rephrasing, or switch model with `/model`."* Provider-fallback on refusal is **not** the default per Anthropic's documented guidance — policies are deliberately different across models, and silent re-routing on safety refusal is the wrong shape. If a per-profile fallback chain is configured (future work in [providers.md](providers.md)) it could opt into refusal-triggered fallback before degrade; not in the baseline. |

**Scope of the refusal subtype (v1):** detection requires an explicit signal from the SDK adapter — `stop_reason: "refusal"` (Anthropic-direct) or `finish_reason: "content_filter"` plus 400-with-content-policy class (OpenAI-direct). `openai-compat.ts` covering OpenAI-compatible providers (OpenRouter, Venice, xAI, generic OpenAI-compat shims) does **not** participate in v1: refusal signals on that surface arrive in too many non-standard shapes (provider-specific 400 bodies, `error.code` inside a 200, empty `choices`, refusal text in a normal `end_turn` reply) for a reliable decoder. LiteLLM does string-pattern matching on error messages and explicitly notes the heuristic is Azure-shaped; that's the prior art and it's brittle. Refusals on OpenAI-compat surfaces degrade through the empty-content path instead: one continuation-prompt budget entry wasted, then degrade. Acceptable cost for v1. Follow-up: per-adapter `decodeRefusal(response): boolean` hook with a permissive regex default for `openai-compat.ts` — wire it when telemetry shows the wasted-budget cost matters.

**Refusal-as-normal-text is not detected.** Older / non-current Anthropic model versions surface refusals as `stop_reason: "end_turn"` with refusal-shaped text. Without a model-side signal, "refusal-shaped text" is heuristic on the content itself — and the false-positive cost (mis-labeling a legitimate text-only reply like "I disagree with that approach because…" as refusal and showing the refusal-degrade message) is worse than the false-negative cost (a refusal slips through as a normal text turn that the user can read and respond to). The post-stream classifier deliberately does NOT detect refusal from text content. Recall on the refusal subtype is best-effort, gated on explicit `stop_reason: "refusal"` or `finish_reason: "content_filter"`.

The refusal subtype requires adapter support: `anthropic.ts` must decode `stop_reason: "refusal"`, `openai-compat.ts` (for OpenAI-direct) must decode `finish_reason: "content_filter"`, and the SDK adapters must surface 400-with-content-policy-error class distinctly from generic 400. Today neither adapter does this (the doc treats it as a precondition).

#### Degraded reply

When a subtype's budget exhausts or the classifier returns `degrade` (refusal goes here immediately; Class D fingerprint trips also land here), the orchestrator posts a single user-visible assistant message:

> I had trouble generating a clean response — the model returned an output I couldn't process. Could you rephrase or try again?

The degraded reply is persisted as a normal assistant message (role `assistant`, single `text` block). Conversation status stays `active`. `conversation/degraded` is emitted right after the durable persist step as a separate `step.sendEvent` call — Inngest's step-level exactly-once delivery covers it, same pattern as `conversation/errored` is dispatched from `onFailure`. No explicit idempotency `id` needed.

**Persistence boundary on a degraded turn:**

- Successful intermediate iterations (tool_use + tool_result pairs whose handlers ran to completion, including their side effects) **are** persisted. Their tool calls already affected the world — file writes, memory retains, image generations — and the conversation transcript must reflect that.
- The single iteration whose response triggered the degrade — empty content, malformed JSON, schema-invalid output — is **not** persisted. That assistant message would be useless in history and risks feeding the model its own broken output on the next turn.
- **Synthetic user turns** injected by the repair flow (continuation prompts, validation-feedback messages) are **not** persisted. They're internal mechanics, not real user input — persisting them would confuse future-turn retrieval and the failure-reflector. This matches the existing ephemeral pattern for `validateHistory`-synthesized tool_results (`history-invariants.ts`) and the `[Previous conversation summary]` turn injected during compaction (`context.ts:234-237`).
- The degraded reply is persisted as the final assistant message of the turn.

The forensic record of *what the model produced before degrading* lives in the `agent.repair` / `agent.degrade` structured logs (see Telemetry below), not in `messages`. The `messages` table is the conversation transcript; structured logs are the failure audit.

#### Tools-free synthesis on degrade `[confirmed]`

The fixed text above is the conservative baseline — no LLM call, deterministic, no failure modes. But it tells the user nothing about *what* the model was trying to do or *why* it stopped. A user who asked for an image and got "I had trouble generating a clean response" can't tell whether to rephrase, switch model, give up, or wait.

The proposed extension: when a degrade fires (Class C exhaustion, Class D fingerprint, volume cluster, iteration cap), do **one** final LLM call **without tools** before posting the degraded reply. The model has the full failure history in context; the call asks it to summarize in user-facing terms what happened and what to try next. The result becomes the degraded reply text, persisted as the final assistant message of the turn.

Synthesis call shape:

- **Tools disabled at the API level** (`tools: []`), not via prompt — belt-and-braces against a model that "helpfully" tries to call a tool from a stale system instruction.
- **Single attempt, no Class C repair on this call.** If it fails for any reason, fall back to the fixed string above and emit `agent.degrade.synthesis` with `ok: false`. Don't degrade-the-degrade — the user has waited long enough.
- **Wall-clock cap of 5s** — tighter than the normal request budget. The user is already waiting on a failed turn.
- **`temperature: 0`** — predictability matters more than variety on a failure reply.
- **System prompt names the stop reason and asks for 1–3 sentences** covering: what was attempted, what went wrong, one concrete next step (rephrase, switch model, try later, etc.). No verbose apology.

Provider for the synthesis call is the same one the failing turn was using — the conversation is already paying for that model's quirks; switching providers on the apology message is a non-sequitur. (A future "this provider is misbehaving" circuit breaker could change this; out of scope here.)

Telemetry:

```typescript
{ event: "agent.degrade.synthesis", reason, subtype?, tokens_in, tokens_out, ok: boolean }
```

Single event name, `ok: boolean` for outcome — no separate `synthesis_failed` event. Downstream queries count failures as `event == "agent.degrade.synthesis" AND ok == false`. The underlying `agent.degrade` log fires regardless of synthesis outcome (the turn is degrading either way); the synthesis event is the per-attempt forensic record.

**Provider-outage falls through cleanly.** When the synthesis call hits a Class A failure on a dead provider, it returns `ok: false` and the fixed string is posted. A spike in `synthesis ok: false` correlated with provider-outage telemetry is *not* a synthesis-logic bug — the synthesis path inherits the failing turn's provider, so any upstream unavailability propagates here. Investigate the upstream symptom in that case, not the synthesis code.

**Cost amplification on long contexts.** The synthesis call re-sends the full conversation history to produce a 1–3 sentence reply. For iteration-cap degrades — where the turn ran long *because the context grew* — that's a non-trivial re-send. The `tokens_in` field on `agent.degrade.synthesis` quantifies it per call; if a future telemetry pass shows a fat tail (large `tokens_in` correlated with `subtype: null` / `reason: "iteration_cap"`), the response is to compact before synthesis, not to skip it — the user is still owed an explanation. Skipping synthesis on long contexts trades a known cost for an unknown UX regression.

### Outside the agent loop

`chatTyped` callsites in evolution background jobs — `drain-pending-memories.ts:194`, `extract-corrections.ts:79`, `extract-memories.ts:67`, `consolidate-rules.ts:121` — and untyped non-loop calls like the summarization step in `handle-message.ts:702` are still Class C surfaces, but they're not inside the agent loop and have no user to degrade to. They use **single-call retry-with-feedback** semantics:

| Aspect | In-loop | Outside the loop |
|-|-|-|
| Budget | Per-turn, per-subtype (continuation: 1, stream-replay: 1, refusal: 0); tool-arg feedback unbounded via the existing `is_error: true` channel | Per-call, per-callsite (default 1; tunable) |
| Repair channel | Append continuation / feedback turn to next iteration; replay non-streaming for stream truncation | Wrap the call in a single retry: parse → on `ZodError`, re-request with validation message appended as a user turn |
| Exhaustion | Degraded reply to user, `conversation/degraded` event | Throw to caller; the Inngest step that owns the callsite uses its own retries + crash-recovery story. No `conversation/degraded` — there's no user-facing conversation in the failure path. |
| Persistence | Synthetic feedback turn ephemeral (above) | Fully ephemeral — the entire call lives inside one Inngest step, no `messages` rows involved |

The repair logic itself is shared. `chatTyped`'s implementation in `src/llm/chat-typed.ts` (or wherever it lives) grows a `repair: { jsonrepair: true, maxRetries: 1, onZodFailure: "feedback" }` option that both surfaces consume. The in-loop classifier invokes it with the same options; the in-loop budget interacts only with the classifier's outcome, not with `chatTyped`'s internal retry. Background jobs invoke `chatTyped` directly and get the same repair behavior without the loop-level wrapper.

## Class D: loop pathology `[confirmed]`

Each loop iteration produces a fingerprint over **tool calls only**:

```
hash(sorted [(tool_use.name, sha256(canonical-json(tool_use.input)))])
```

Arguments must be in the hash, not just names: three `read_file` calls against `a.txt`, `b.txt`, `c.txt` is legitimate exploration of read-only state, not a stuck loop. Name-only hashing would false-positive on that sequence.

The inner list is **sorted** so a model that varies the emission order of parallel-safe tool calls between iterations — `[search, fetch]` then `[fetch, search]` with otherwise-identical args — still produces the same fingerprint. The fingerprint asks "did this iteration do the same work as the previous one?" — emission order isn't part of the work, so it shouldn't be part of the hash.

The fingerprint deliberately **excludes assistant text**. Text prefixes are brittle: timestamps in the reply, hedging preambles ("Let me think…"), emoji-noise — two iterations doing identical redundant tool work but emitted with different openers would not match. The side-effect gate below already protects against killing useful pure-text replies, so the text component would only add false negatives.

The trip uses **two** conditions, layered:

1. **Consecutive trigger:** three consecutive iterations produce the same fingerprint AND none of those iterations' tool calls produced an observable side effect.
2. **Cumulative trigger:** the same fingerprint appears five times total across the run (regardless of consecutiveness) AND none of those occurrences produced a side effect.

The cumulative trigger catches alternating patterns (`A, B, A, B, A` — three `A`s in five iterations, never three in a row) that escape the consecutive rule. AgentPatterns' `LoopGuard` uses a similar shape (per-signature global occurrence count + consecutive counter + flat-step counter); K-of-N is not a canonical industry primitive, but the layered consecutive+cumulative shape is.

**Free upside: bounds runaway tool-arg validation feedback.** Tool-arg validation feedback is unbounded by design ([above](#repair-budgets) — the `is_error: true` channel lets the model self-correct multiple sequential Zod failures). If a model retries identical malformed args across iterations, the fingerprint matches (same `(name, args-hash)` tuple), the side-effect gate doesn't fire (validation rejected before the handler), and Class D catches it earlier than the `DEFAULT_MAX_ITERATIONS = 20` backstop — with proper subtype telemetry instead of a silent iteration-cap trip.

When either trigger fires:

- Loop exits with `{ kind: "degraded", reason: "stuck_loop" }`
- Orchestrator posts the degraded reply
- `conversation/degraded` event carries `subtype: "stuck_loop"` (consecutive) or `subtype: "stuck_loop_cumulative"` (cumulative)

The hard cap `DEFAULT_MAX_ITERATIONS = 20` remains as the backstop. Hitting it also trips a degrade with `reason: "iteration_cap"`. **Invariant:** every `conversation/degraded` event has either a classifier outcome or a backstop trigger (`iteration_cap`). Degrade never fires silently.

### Prerequisite: tool side-effect classification

The side-effect gate requires every `ToolSpec` to declare `sideEffectful: boolean`. The field doesn't exist today (`tools.ts:18-48` carries `name`, `description`, `inputSchema`, `handler`, `durable?`, `parallelSafe?`).

**Default:** `true` (fail-safe). A read-only tool is the surprising case, not the default; a missing flag should never cause Class D to wrongly trip on a tool that genuinely makes progress. Tools opt in to `sideEffectful: false`:

- File reads: `read_file`, `list_files`
- Web reads: `web_search`, `web_answer`, `fetch_url`
- Memory reads: `memory_recall`, `memory_reflect`, `core_memory_read`
- Scheduling reads: `list_tasks`
- Clock: `get_current_time`

`memory_reflect` is read-only despite being billable and `durable: true` — its synthesis writes nothing, and a stuck loop calling it with identical args is exactly what Class D should catch. `core_memory_read` reads agent-owned state (blocks the agent itself writes via `core_memory_update`); identical repeat calls also make no progress and should trip the gate.

**Field shape.** `sideEffectful?: boolean` on `ToolSpec`, with consumers reading `spec.sideEffectful ?? true`. Optional-plus-consumer-default matches the existing `durable?` / `parallelSafe?` convention on the same interface and keeps the migration trivial — third-party / plugin tools added later inherit the fail-safe default without touching their spec.

Adding the field is a one-shot migration: extend `ToolSpec` in `src/agent/tools.ts`, default to `true` at the consumer level, mark the read-only set above as `false`. Without this migration, the side-effect gate defaults to "always trip" and Class D never fires — so the migration is a precondition for shipping Class D detection, not an optional follow-up.

### Volume cluster trigger `[confirmed]`

The fingerprint above catches the loop doing the *same work* repeatedly — `(name, args)` matches twice. It does not catch the loop doing *similar work at high volume* — six `generate_image` calls with different prompts, eight `web_search`es with varying queries. Each call is unique by fingerprint, so the existing trigger ignores it. The LLM's softmax attention budget does not make the same distinction: every additional same-tool result block dilutes attention on the original user intent, and the lost-in-the-middle effect compounds as same-tool results stack. Class D today catches the *repetition* corner case of loop pathology; the volume-cluster trigger closes the *accumulation* case.

The mechanism is intentionally outcome-agnostic. A failure-only counter under-fires: ten successful `web_search`es returning slightly different but redundant results dilute attention as much as ten failures, and the existing class-C/D plumbing already handles the all-failure case via fingerprint-on-identical-retry. The gap is "the loop made progress per-call but not per-turn" — a signal only volume captures.

#### Mechanism

A per-tool **batch** counter increments once per *iteration* that emits any `tool_use` block targeting tool `T`, scoped to one `runStreamingAgentLoop` invocation. When the prior-batch count for `T` reaches `T.invocationBudget`, the next iteration's same-tool batch is intercepted **as a whole**: every `tool_use` block targeting `T` in that iteration is replaced with an `is_error: true` `tool_result` (paired by id), the handlers never run, and the loop synthesizes one telemetry emission for the batch.

**Per-iteration, not per-block.** The cluster trigger targets the model's *decision pattern* across iterations, not the parallelism within one decision. An iteration emitting 10 parallel `tool_use` blocks for `T` is one batch — the model made a single decision to call `T` with 10 arguments. A user requesting "generate 10 images" usually produces either one iteration with 10 parallel blocks (one batch, admitted) or ten sequential iterations (ten batches, intercepted starting at the budget). The failure mode the trigger catches — "model didn't see this result and decide it was enough, then decided to call again anyway" — is per-iteration behavior. Counting per-block would conflate that failure with legitimate user-explicit batches and parallel-safe tool fan-out, producing false positives like "I can only generate 2 of your 10 requested images."

A by-product: an admitted batch can contain arbitrarily many parallel calls. The trigger isn't a cost control; per-call cost ceilings belong to per-tool rate limits / cost caps elsewhere. The trigger's job is loop-pathology detection.

**Implementation note: derive, don't store.** The batch counter must be recomputed by scanning the iteration's accumulated message array on each check, not maintained as a closure variable. Inngest function replay on retry replays cached `step.run` outputs in order but re-executes everything outside `step.run` from the top — a counter held in a closure resets to zero on every retry, silently letting the budget reset mid-turn. Deriving from the message array reflects the actual current state regardless of replay, and the scan is O(N) over a single-turn message array (cheap at the iteration count cap).

Nudge text branches on outcome mix in the existing history:

- **All failures:** "Every attempt to call `T` this turn failed (reasons: …). Do not call `T` again — change strategy."
- **Mixed:** "K of N `T` calls produced results. Do not call `T` again — decide from what you have."
- **All success:** "You have N results from `T`. Do not call `T` again — synthesize and reply."

The batch counter persists across the whole turn regardless of per-call outcome. Volume is the signal: successful same-tool results dilute attention the same as failed ones (the softmax weight on the original user intent shrinks either way), so the budget is a volume cap, not a failure cap. A model that wants more bandwidth for one tool than its budget allows should ask the user or switch tools — that's the redirect the nudge text enforces. The reset happens at turn boundary (next `runStreamingAgentLoop` invocation), not within a turn.

#### Per-tool budgets on `ToolSpec`

`ToolSpec` grows an optional `invocationBudget?: number`. Consumers read `spec.invocationBudget ?? DEFAULT_INVOCATION_BUDGET` (default `5`), matching the existing optional-plus-consumer-default convention for `durable?`, `parallelSafe?`, `sideEffectful?`.

Budgets cap **iterations**, not individual calls. A budget of `B` admits the first `B` iterations in which the model emits any tool_use for `T`; the `(B+1)`th iteration's whole same-tool batch intercepts.

| Tool class | Budget | Why |
|-|-|-|
| Image generation | 2 | 2 iterations of image-gen attempts before the trigger fires. Each iteration can be one call or a parallel batch — the across-iteration count is what catches the retry-loop failure mode. |
| `web_search`, `fetch_url` | 5 | 5 iterations — genuine multi-source research distributed across iterations is normal up to ~5. |
| `read_file`, `list_files` | 10 | 10 iterations. Codebase exploration usually batches multiple reads per iteration, so this is a generous across-iteration cap. |
| `memory_recall` | 3 | Repeated recall iterations on one turn usually means the model isn't finding what it wants — nudge to switch tactics earlier. |
| Default | 5 | Conservative fail-safe; tune from telemetry. |

The field is keyed on `tool` not on `(tool, args)` — ten `read_file` iterations against ten different paths is normal exploration (10 batches against budget 10), but ten different prompts to `generate_image` across ten iterations is the failure mode this catches. Distinguishing by args at the budget layer would re-create the fingerprint's blind spot.

#### Composition with the fingerprint trigger

Both triggers run concurrently. They catch disjoint patterns:

- **Fingerprint** trips on `(name, args)` repetition: same tool, same args, 3 consecutive or 5 cumulative iterations.
- **Volume cluster** trips on across-iteration `name` repetition regardless of args: same tool emitted in `> budget` distinct iterations.

A loop that varies args to evade the fingerprint hits the volume trigger. A loop that doesn't vary hits the fingerprint first. Neither fires when the model uses different tools (legitimate multi-step work) or the same read-only tool across many iterations within budget (legitimate exploration). A single iteration with many parallel same-tool blocks is one batch — neither trigger interprets it as a stuck signal.

#### Trip semantics — redirect, not terminate

The cluster trigger is a **repair**, not a degrade. When it fires:

- The intercepted `tool_use` is **not** executed. No handler runs, no side effect, no provider cost.
- The synthetic `tool_result` is appended to the iteration's results, **carrying the intercepted `tool_use`'s `id`** to satisfy Anthropic's tool_use ↔ tool_result pairing requirement. The `tool_use` block exists in the assistant message regardless of handler execution; a matching `tool_result` must exist on the next user message or the API rejects the conversation. Intercept happens *after* the block lands in the assistant message and *before* the handler runs.
- The loop continues — the model receives the nudge and emits its next response.

If the model ignores the nudge and emits another `tool_use` for `T`, the args are likely identical to a prior call (the model has no new information). The existing fingerprint catches that as the consecutive trigger and degrades on `stuck_loop`. Volume cluster → fingerprint → degrade is the staircase; the volume trigger redirects, the fingerprint terminates.

#### Telemetry

```typescript
{ event: "agent.repair", subtype: "volume_cluster", tool: T, batchCount, callCount, blocksInBatch, budget, outcomeMix }
```

`batchCount` is the across-iteration counter the budget compared against; `callCount` is the total `tool_use` block count this turn (what the nudge text shows the model); `blocksInBatch` distinguishes a one-block iteration that intercepts (`blocksInBatch: 1`) from a parallel batch that intercepts as a unit (`blocksInBatch: N`). One emission per intercepted batch — not per blocked block.

No separate degrade event — the cluster trigger is a repair. The follow-on degrade (if the model ignores the nudge) is the existing `stuck_loop` event.

#### Prerequisite

`ToolSpec.invocationBudget?` ships before the trigger code does, same way `sideEffectful` had to ship before the side-effect gate. Default-at-consumer (`?? DEFAULT_INVOCATION_BUDGET`) keeps the migration to a single PR — no per-tool retrofitting required for the trigger to light up; tool-specific overrides land incrementally as telemetry justifies them.

## Telemetry `[confirmed]`

Every repair attempt and every degrade decision emits a structured log line (Pino `logger.warn`, **not** an Inngest event — these do not transit `step.sendEvent` and need no idempotency `id`):

```typescript
{ event: "agent.repair", subtype, instructions: { kind: "continuation_prompt" | "json_repair" | "feedback_injection" | "disable_stream" } }
{ event: "agent.degrade", reason, subtype? }
```

The durable Inngest signal is `conversation/degraded` (emitted once per degraded turn from inside the persist step — see "Degraded reply" above). The structured logs are the per-attempt forensic record. The evolution failure-reflector subscribes to the Inngest event and can join the logs by `runId` + `conversationId` for subtype-level analysis.

**Prerequisite: log context plumbing.** The base Pino logger today (`logger.ts:13-18`) carries no per-invocation context, and `runId` (exposed by Inngest as `async ({ event, step, runId })`) is never threaded into child loggers. The join is broken until plumbing lands.

**Baseline: child logger threaded through the loop.** `handle-message` creates `const turnLogger = logger.child({ runId, conversationId })` at function entry and passes it as a new field on `StreamingAgentLoopParams`. The classifier inside `runStreamingAgentLoop` emits through `turnLogger.warn(...)`; subtype/instructions fields are added per-emission, but `runId` and `conversationId` are inherited from the child's bound context. Future telemetry calls inside the loop get the run context for free without per-call ceremony.

The per-emission alternative — `logger.warn({ runId, conversationId, ... }, "...")` at every callsite — looked cheaper but isn't: the classifier sits deep inside `runStreamingAgentLoop`, so `runId` has to be threaded through the params anyway. The signature change is the same; the child logger costs one extra field, and every future emission inherits the context.

## Where the layers compose `[confirmed]`

```
Inngest function `handle-message`             (Class A retries: 2)
  └── runStreamingAgentLoop                   (Class C per-subtype budgets, Class D fingerprint)
        └── FallbackLlmProvider               (Class A provider chain)
              └── Anthropic / OpenAI adapter  (SDK-level HTTP retries)
```

Each layer handles one class. None of them double-handles another layer's class:

- SDK adapters retry on HTTP-level transient codes only. **Class C parse failures (malformed JSON in the streamed `input_json_delta` accumulator) are wrapped at the throw site as `ProviderProtocolError`** before propagating. The wrap is essential — without it, the bare `SyntaxError` has no `status` field and `FallbackLlmProvider` would treat it as a transient network failure.
- `FallbackLlmProvider` tries next provider on Class A; propagates everything else. Its `isRetriableProviderError` predicate stays binary (`true` = try next, `false` = propagate); the trick is an `instanceof ProviderProtocolError` guard placed before the `status == null → true` rule, so Class C escapes the chain without changing the predicate's two-way shape. This is the **only** Class C interaction with the provider layer — once propagated, the in-loop classifier owns the rest.
- The in-loop classifier owns all Class C/D handling for callsites inside the agent loop.
- Non-loop Class C callsites (evolution drains, summarization — see "Outside the agent loop" above) use single-call retry inside `chatTyped` / wrapper; they never reach the classifier.
- Inngest's outer `retries: 2` retries Class A failures that escaped the provider chain (mid-stream socket reset after first event, etc.); cached durable steps replay; the streaming section re-runs.

## Out of scope / explicit non-goals `[confirmed]`

| Idea | Why excluded |
|-|-|
| Temperature bumping on retry | Folk wisdom — no framework codifies it. Anthropic explicitly recommends against naive same-prompt retry for empty `end_turn`. Sampling tweaks can be added if real telemetry shows they help; not part of the baseline design. |
| Schema simplification on retry (flatten nested objects, drop optional fields) | `tool-input-coercion.ts` handles stringified objects; `jsonrepair` handles malformed JSON. Schema rewriting on retry adds a moving target without closing a class these two don't already cover. |
| Constrained decoding (OpenAI strict mode, OpenRouter structured outputs, grammar-constrained sampling) | Eliminates the parse-failure class at the source. Lives in [providers.md](providers.md) and the `LlmProvider` interface, not here — orthogonal to the repair pathway. Where constrained decoding is in effect, the in-loop classifier still runs but has nothing to repair. |
| Per-tool fallback model chains (`models: [primary, fallback]` at the tool spec) | Per-profile fallback belongs in the provider resolver, not at tool granularity. Tracked in [providers.md](providers.md). |
| Failure-rate circuit breaker per conversation ("this model is bad here, suggest `/model`") | Could surface as a steering rule from telemetry; doesn't belong in the loop. |
| Activity-based tool timeouts | Stuck *tools* — covered separately in [agents.md](agents.md) → Activity-Based Timeouts. This doc covers broken *responses*. |

## Deferred follow-ups `[proposed]`

Decisions taken with their follow-up trigger. Not blockers — listed so the rationale is durable and reviewers don't relitigate.

1. **Per-conversation repair budget.** Current design budgets per-turn (one Inngest invocation). Per-conversation would catch "this conversation keeps repairing" without an extra signal but risks one bad model burning budget across many turns. Wire if telemetry shows the same conversation repairing on most turns.
2. **`repair_attempts` column on `messages`.** Today the design persists only the final degraded reply plus successful intermediate iterations. A JSONB column would let the failure-reflector query historically by SQL. In the interim the `agent.repair` / `agent.degrade` structured logs (see [Telemetry](#telemetry-confirmed)) carry the same forensic data — the reflector joins logs to events by `runId` + `conversationId` without an extra column. Wire when SQL access becomes necessary.
3. **Per-provider Class C rate counter with paging threshold.** A per-provider counter (`agent.classC.rate{provider}`) with a threshold ("rate > 10% over 1h → page") would surface a degraded provider before the bill. Wire when there's a metrics sink to attach to.
4. **Per-adapter `decodeRefusal` hook for OpenAI-compat.** OpenAI-compat refusals degrade through the empty-content path in v1 (see [Class C](#class-c-model-misbehavior-proposed)). Wire a permissive regex-default hook when telemetry shows the wasted continuation-prompt budget is a real cost driver.
5. **Telemetry-driven degraded → cooldown escalation.** Today repeated `degraded` events on the same conversation surface in telemetry but never escalate. A threshold ("5 degrades within 10 minutes → enter cooldown") would treat chronic in-loop failure as equivalent to a Class B failure for circuit-breaker purposes. Wire when telemetry shows real conversations stuck in repeat-degrade loops.

The failure-reflector's downstream consumption — proposing steering rules from repair-subtype telemetry — lives in [evolution.md](evolution.md), not here.

## Related docs `[confirmed]`

- [crash-recovery.md](crash-recovery.md) — Inngest durability. The repair budget lives inside one Inngest invocation; the durability map is unchanged.
- [agents.md](agents.md) → Tool Architecture — the `is_error: true` `tool_result` channel used here for schema-validation feedback.
- [providers.md](providers.md) — `FallbackLlmProvider` and Class A handling.
- [transport/streaming.md](transport/streaming.md) — degraded replies use the same delivery path as normal replies.
- [evolution.md](evolution.md) → failure-reflector — consumes `conversation/errored` and `conversation/degraded`.
