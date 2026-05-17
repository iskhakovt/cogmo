# Agent Resilience `[proposed]`

How the agent loop handles **LLM provider misbehavior** — empty assistant turns, malformed tool arguments, truncated structured output, refusals where a tool call was required.

Distinct from [crash-recovery.md](crash-recovery.md), which covers Inngest durability (process death, step replay, exactly-once side effects). That doc answers *we lost the worker*; this one answers *the model returned something we can't use*.

## Failure taxonomy `[proposed]`

Every provider failure falls into one of four classes. The class determines the response.

| Class | Examples | Response |
|-|-|-|
| **A. Transport / infra** | DNS/TLS timeout, 408, 425, 429, any 5xx, mid-stream socket reset before first event | Provider chain (`FallbackLlmProvider`) tries the next candidate. Inngest `retries: 2` retries the whole turn if the chain exhausts. |
| **B. Provider-permanent** | 4xx auth/quota, model deprecated, malformed tool schema (ours), `ProviderConfigError` | `NonRetriableError`. `onFailure` emits `conversation/errored`. `recover-conversation` flips `conversations.status = 'errored'`. Future inbound is skipped until a human resets it. |
| **C. Model misbehavior, recoverable** | Empty `content` + `end_turn`, truncated tool-arg JSON, schema-invalid `chatTyped` output, model refusal (`stop_reason: "refusal"` / `finish_reason: "content_filter"` / 400 with content-policy class) | **In-loop per-subtype repair budgets** (most subtypes: 1; refusal: 0, immediate degrade). On exhaustion: degraded reply, conversation stays `active`. |
| **D. Loop pathology** | N consecutive turns producing the same tool calls with no successful side effect; iteration cap hit | Progress fingerprint trips → degraded reply, conversation stays `active`. |

Class A and B are provider-layer concerns and live in `FallbackLlmProvider` + `resolveOrFail`. This doc covers C and D.

## Off-ramps `[proposed]`

A turn ends in one of three states. Each is a durable signal downstream consumers (evolution failure-reflector, telemetry) can subscribe to.

| Off-ramp | Status | Event | Trigger |
|-|-|-|-|
| Normal | `active` | `response/ready` | Turn produced a usable assistant reply |
| Degraded | `active` | `conversation/degraded` | Class C repair budget exhausted, or Class D fingerprint tripped. User sees a system-generated apology; can retry. |
| Errored | `errored` | `conversation/errored` | Class B failure, Inngest function retries exhausted on Class A, history-invariant violation, programmer-bug exception. Requires human reset. |

`errored` is a circuit breaker for invariant violations and persistent infrastructure failure. `degraded` is a soft recovery for "the model wouldn't cooperate." Class C never escalates to `errored` — repeated Class C exhaustion on the same conversation produces repeated `degraded` events, each carrying its subtype tag for telemetry.

**`degraded` is an event, not a status.** The conversation row's `status` enum stays `'active' | 'errored'`; the semantic distinction "the last turn was degraded" lives in the `conversation/degraded` event stream, not in a third enum value. No major agent framework introduces a `degraded` conversation status (OpenAI Threads keep thread-level state binary with run-level status enums; Letta tracks per-step `stop_reason`; CrewAI / AutoGen rely on event signals only). A separate `'degraded'` enum value wouldn't intrinsically gate anything — any gating behavior would come from a check we'd have to add to `handle-message`'s entry guard — so it would be net new complexity without buying anything the event signal doesn't already deliver.

## Class C: model misbehavior `[proposed]`

Class C has two handling surfaces. Most callsites are inside the agent loop, where a per-turn repair budget and a degraded-reply off-ramp apply. A few callsites — typed structured-output calls in background jobs, summarization — live outside the loop and use single-call retry-with-feedback instead, with no shared budget. The repair *semantics* (feedback-injection, JSON repair, continuation prompts) are the same; the *budgeting* and *off-ramp* differ. The Pydantic AI split between `tool_retries` (inside the agent loop) and `output_retries` (per-call validation) is the closest external precedent — Instructor's per-call `max_retries` covers the non-loop pattern.

### In-loop repair

#### Classifier

A turn classifier runs at two points inside `runStreamingAgentLoop`:

1. **Post-stream**, after content blocks are reconstructed, before the `hasToolUse` gate. Detects: empty content, refusal-only content (text with no tool call when one was required), truncation mid-`tool_use`.
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
| Stream truncated mid-`tool_use` (`stop_reason: "max_tokens"` with partial JSON) | Replay non-streaming with the same params. Single-shot token budget often completes where the chunked stream did not. If the replay itself hits a Class A failure, normal Class A handling applies (provider chain → Inngest `retries: 2`); the stream-replay budget is consumed regardless of replay outcome. |
| Model refusal | Immediate degrade — no repair attempt. Degraded-reply text is refusal-specific: *"The model declined that request. Try rephrasing, or switch model with `/model`."* Provider-fallback on refusal is **not** the default per Anthropic's documented guidance — policies are deliberately different across models, and silent re-routing on safety refusal is the wrong shape. If a per-profile fallback chain is configured (future work in [providers.md](providers.md)) it could opt into refusal-triggered fallback before degrade; not in the baseline. |

The model-refusal subtype requires adapter support: `anthropic.ts` must decode `stop_reason: "refusal"`, `openai-compat.ts` must decode `finish_reason: "content_filter"`, and the SDK adapters must surface 400-with-content-policy-error class distinctly from generic 400. Today neither adapter does this (the doc treats it as a precondition).

#### Degraded reply

When a subtype's budget exhausts or the classifier returns `degrade` (refusal goes here immediately; Class D fingerprint trips also land here), the orchestrator posts a single user-visible assistant message:

> I had trouble generating a clean response — the model returned an output I couldn't process. Could you rephrase or try again?

The degraded reply is persisted as a normal assistant message (role `assistant`, single `text` block). Conversation status stays `active`. `conversation/degraded` is emitted from inside the orchestrator's durable persist step, so the wrapping `step.run` provides exactly-once delivery (same pattern as `conversation/errored` in `onFailure`) — no explicit idempotency `id` needed.

**Persistence boundary on a degraded turn:**

- Successful intermediate iterations (tool_use + tool_result pairs whose handlers ran to completion, including their side effects) **are** persisted. Their tool calls already affected the world — file writes, memory retains, image generations — and the conversation transcript must reflect that.
- The single iteration whose response triggered the degrade — empty content, malformed JSON, schema-invalid output — is **not** persisted. That assistant message would be useless in history and risks feeding the model its own broken output on the next turn.
- **Synthetic user turns** injected by the repair flow (continuation prompts, validation-feedback messages) are **not** persisted. They're internal mechanics, not real user input — persisting them would confuse future-turn retrieval and the failure-reflector. This matches the existing ephemeral pattern for `validateHistory`-synthesized tool_results (`history-invariants.ts`) and the `[Previous conversation summary]` turn injected during compaction (`context.ts:234-237`).
- The degraded reply is persisted as the final assistant message of the turn.

The forensic record of *what the model produced before degrading* lives in the `agent.repair` / `agent.degrade` structured logs (see Telemetry below), not in `messages`. The `messages` table is the conversation transcript; structured logs are the failure audit.

### Outside the agent loop

`chatTyped` callsites in evolution background jobs — `drain-pending-memories.ts:194`, `extract-corrections.ts:79`, `extract-memories.ts:67`, `consolidate-rules.ts:121` — and untyped non-loop calls like the summarization step in `handle-message.ts:702` are still Class C surfaces, but they're not inside the agent loop and have no user to degrade to. They use **single-call retry-with-feedback** semantics:

| Aspect | In-loop | Outside the loop |
|-|-|-|
| Budget | Per-turn, per-subtype (continuation: 1, stream-replay: 1, refusal: 0); tool-arg feedback unbounded via the existing `is_error: true` channel | Per-call, per-callsite (default 1; tunable) |
| Repair channel | Append continuation / feedback turn to next iteration; replay non-streaming for stream truncation | Wrap the call in a single retry: parse → on `ZodError`, re-request with validation message appended as a user turn |
| Exhaustion | Degraded reply to user, `conversation/degraded` event | Throw to caller; the Inngest step that owns the callsite uses its own retries + crash-recovery story. No `conversation/degraded` — there's no user-facing conversation in the failure path. |
| Persistence | Synthetic feedback turn ephemeral (above) | Fully ephemeral — the entire call lives inside one Inngest step, no `messages` rows involved |

The repair logic itself is shared. `chatTyped`'s implementation in `src/llm/chat-typed.ts` (or wherever it lives) grows a `repair: { jsonrepair: true, maxRetries: 1, onZodFailure: "feedback" }` option that both surfaces consume. The in-loop classifier invokes it with the same options; the in-loop budget interacts only with the classifier's outcome, not with `chatTyped`'s internal retry. Background jobs invoke `chatTyped` directly and get the same repair behavior without the loop-level wrapper.

## Class D: loop pathology `[proposed]`

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

When either trigger fires:

- Loop exits with `{ kind: "degraded", reason: "stuck_loop" }`
- Orchestrator posts the degraded reply
- `conversation/degraded` event carries `subtype: "stuck_loop"` (consecutive) or `subtype: "stuck_loop_cumulative"` (cumulative)

The hard cap `DEFAULT_MAX_ITERATIONS = 20` remains as the backstop. Hitting it also trips a degrade with `reason: "iteration_cap"`. **Invariant:** every `conversation/degraded` event has either a classifier outcome or a backstop trigger (`iteration_cap`). Degrade never fires silently.

### Prerequisite: tool side-effect classification

The side-effect gate requires every `ToolSpec` to declare `sideEffectful: boolean`. The field doesn't exist today (`tools.ts:18-48` carries `name`, `description`, `inputSchema`, `handler`, `durable?`, `parallelSafe?`).

**Default:** `true` (fail-safe). A read-only tool is the surprising case, not the default; a missing flag should never cause Class D to wrongly trip on a tool that genuinely makes progress. Tools opt in to `sideEffectful: false`:

- `read_file`, `list_files`, `current_time`
- `web_search`, `fetch_url`, `web_answer`
- `memory_recall`

Adding the field is a one-shot migration: extend `ToolSpec` in `src/agent/tools.ts`, default to `true` at the spec level, mark the read-only set above as `false`. Without this migration, the side-effect gate defaults to "always trip" and Class D never fires — so the migration is a precondition for shipping Class D detection, not an optional follow-up.

## Telemetry `[proposed]`

Every repair attempt and every degrade decision emits a structured log line (Pino `logger.warn`, **not** an Inngest event — these do not transit `step.sendEvent` and need no idempotency `id`):

```typescript
{ event: "agent.repair", subtype, instructions: { kind: "continuation_prompt" | "json_repair" | "feedback_injection" | "disable_stream" } }
{ event: "agent.degrade", reason, subtype? }
```

The durable Inngest signal is `conversation/degraded` (emitted once per degraded turn from inside the persist step — see "Degraded reply" above). The structured logs are the per-attempt forensic record. The evolution failure-reflector subscribes to the Inngest event and can join the logs by `runId` + `conversationId` for subtype-level analysis.

**Prerequisite: log context plumbing.** The base Pino logger today (`logger.ts:13-18`) carries no per-invocation context, and `runId` (exposed by Inngest as `async ({ event, step, runId })`) is never threaded into child loggers. The join is broken until one of these lands:

1. (Preferred — less invasive.) Each `agent.repair` / `agent.degrade` emission explicitly includes `runId` and `conversationId` as fields: `logger.warn({ runId, conversationId, event: "agent.repair", ... }, "...")`. No logger-context plumbing; the join works on field names.
2. `handle-message` creates a child logger at function entry — `const turnLogger = logger.child({ runId, conversationId })` — and threads it through service dependencies that emit repair/degrade logs. Slightly cleaner at the callsite but requires adding a logger field to `Service` or passing the child logger explicitly.

Option (1) is the baseline. Option (2) is a follow-up once enough callsites need it to justify the plumbing.

## Where the layers compose `[proposed]`

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

## Out of scope / explicit non-goals `[proposed]`

| Idea | Why excluded |
|-|-|
| Temperature bumping on retry | Folk wisdom — no framework codifies it. Anthropic explicitly recommends against naive same-prompt retry for empty `end_turn`. Sampling tweaks can be added if real telemetry shows they help; not part of the baseline design. |
| Schema simplification on retry (flatten nested objects, drop optional fields) | `tool-input-coercion.ts` handles stringified objects; `jsonrepair` handles malformed JSON. Schema rewriting on retry adds a moving target without closing a class these two don't already cover. |
| Constrained decoding (OpenAI strict mode, OpenRouter structured outputs, grammar-constrained sampling) | Eliminates the parse-failure class at the source. Lives in [providers.md](providers.md) and the `LlmProvider` interface, not here — orthogonal to the repair pathway. Where constrained decoding is in effect, the in-loop classifier still runs but has nothing to repair. |
| Per-tool fallback model chains (`models: [primary, fallback]` at the tool spec) | Per-profile fallback belongs in the provider resolver, not at tool granularity. Tracked in [providers.md](providers.md). |
| Failure-rate circuit breaker per conversation ("this model is bad here, suggest `/model`") | Could surface as a steering rule from telemetry; doesn't belong in the loop. |
| Activity-based tool timeouts | Stuck *tools* — covered separately in [agents.md](agents.md) → Activity-Based Timeouts. This doc covers broken *responses*. |

## Open questions `[proposed]`

1. **Repair budget granularity.** Per-turn (current design) keeps the budgets at the Inngest invocation boundary. Per-conversation would catch "this conversation keeps repairing" without an extra signal but risks letting one bad model burn budget across many turns. Default: per-turn.
2. **Degraded turn persistence shape.** Today the design persists only the final degraded reply plus the successful intermediate iterations. A `repair_attempts JSONB` column on `messages` (or a sibling table) would let the failure-reflector query historically by SQL. In the interim the `agent.repair` / `agent.degrade` structured logs (see [Telemetry](#telemetry-proposed)) carry the same forensic data — the reflector can join logs to events by `runId` + `conversationId` without an extra column. Defer the column until SQL access is needed.
3. **Per-provider Class C rate counter with paging threshold.** Every repair burns an extra LLM call; a provider that suddenly returns 30% Class C costs 30% more with no alert. A per-provider counter (`agent.classC.rate{provider}`) with a threshold ("rate > 10% over 1h → page") would surface a degraded provider before the bill. Wire when there's a metrics sink to attach to.
4. **Repair telemetry as steering signal.** If specific subtypes recur for specific models, the evolution failure-reflector could propose a steering rule ("prefer Sonnet for `schedule_task`"). Out of scope here; lives in [evolution.md](evolution.md).

## Related docs `[confirmed]`

- [crash-recovery.md](crash-recovery.md) — Inngest durability. The repair budget lives inside one Inngest invocation; the durability map is unchanged.
- [agents.md](agents.md) → Tool Architecture — the `is_error: true` `tool_result` channel used here for schema-validation feedback.
- [providers.md](providers.md) — `FallbackLlmProvider` and Class A handling.
- [transport/streaming.md](transport/streaming.md) — degraded replies use the same delivery path as normal replies.
- [evolution.md](evolution.md) → failure-reflector — consumes `conversation/errored` and `conversation/degraded`.
