# Agent Resilience `[proposed]`

How the agent loop handles **LLM provider misbehavior** — empty assistant turns, malformed tool arguments, truncated structured output, refusals where a tool call was required.

Distinct from [crash-recovery.md](crash-recovery.md), which covers Inngest durability (process death, step replay, exactly-once side effects). That doc answers *we lost the worker*; this one answers *the model returned something we can't use*.

## Failure taxonomy `[proposed]`

Every provider failure falls into one of four classes. The class determines the response.

| Class | Examples | Response |
|-|-|-|
| **A. Transport / infra** | DNS/TLS timeout, 408, 425, 429, any 5xx, mid-stream socket reset before first event | Provider chain (`FallbackLlmProvider`) tries the next candidate. Inngest `retries: 2` retries the whole turn if the chain exhausts. |
| **B. Provider-permanent** | 4xx auth/quota, model deprecated, content moderation, malformed tool schema (ours), `ProviderConfigError` | `NonRetriableError`. `onFailure` emits `conversation/errored`. `recover-conversation` flips `conversations.status = 'errored'`. Future inbound is skipped until a human resets it. |
| **C. Model misbehavior, recoverable** | Empty `content` + `end_turn`, truncated tool-arg JSON, schema-invalid `chatTyped` output, refusal-without-tool-call when one was required | **In-loop repair budget** (one attempt, varied by subtype). On exhaustion: degraded reply, conversation stays `active`. |
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

#### Repair budget

One repair attempt per turn, shared across all Class C subtypes. The counter is on the turn boundary (one Inngest invocation of `handle-message`), not per iteration of the agent loop. A turn that hits an empty-content failure, repairs, then hits a JSON parse failure on the repaired turn degrades — it does not get a second repair.

The repair runs inside the same Inngest invocation. The outer `retries: 2` remains exclusively for Class A. A Class A retry that succeeds gets a fresh Class C budget because each Inngest invocation is logically a new turn from the user's perspective.

#### Per-subtype repair

| Subtype | Repair |
|-|-|
| Empty `content` + `end_turn` | Append a user turn with a continuation nudge ("Please complete your response."). Per Anthropic's [stop-reason guidance](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), naive same-prompt retry does not help — the continuation prompt is the documented recovery. |
| Truncated / invalid JSON in tool-arg stream | Run `jsonrepair` on the buffered chunks before declaring failure. If repair produces valid JSON, validate against Zod and proceed. If repair fails, escalate to feedback-injection. |
| Tool-arg validation failure (Zod fails after coercion + repair) | Append an `is_error: true` `tool_result` with the validation message — the same channel handler exceptions already use (`loop.ts:265-270`) — and let the LLM see the error in its next iteration. |
| Stream truncated mid-`tool_use` (`stop_reason: "max_tokens"` with partial JSON) | Replay non-streaming with the same params. Single-shot token budget often completes where the chunked stream did not. If the replay itself hits a Class A failure, normal Class A handling applies (provider chain → Inngest `retries: 2`); the C budget is consumed regardless of replay outcome, since the failure was a Class C trigger. |

#### Degraded reply

When the budget exhausts or the classifier returns `degrade`, the orchestrator posts a single user-visible assistant message:

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
| Budget | Per-turn, shared across subtypes (1) | Per-call, per-callsite (default 1; tunable) |
| Repair channel | Append continuation / feedback turn to next iteration; replay non-streaming for stream truncation | Wrap the call in a single retry: parse → on `ZodError`, re-request with validation message appended as a user turn |
| Exhaustion | Degraded reply to user, `conversation/degraded` event | Throw to caller; the Inngest step that owns the callsite uses its own retries + crash-recovery story. No `conversation/degraded` — there's no user-facing conversation in the failure path. |
| Persistence | Synthetic feedback turn ephemeral (above) | Fully ephemeral — the entire call lives inside one Inngest step, no `messages` rows involved |

The repair logic itself is shared. `chatTyped`'s implementation in `src/llm/chat-typed.ts` (or wherever it lives) grows a `repair: { jsonrepair: true, maxRetries: 1, onZodFailure: "feedback" }` option that both surfaces consume. The in-loop classifier invokes it with the same options; the in-loop budget interacts only with the classifier's outcome, not with `chatTyped`'s internal retry. Background jobs invoke `chatTyped` directly and get the same repair behavior without the loop-level wrapper.

## Class D: loop pathology `[proposed]`

Each loop iteration produces a fingerprint:

```
hash(
  sorted [(tool_use.name, sha256(canonical-json(tool_use.input)))],
  last assistant text prefix [256 chars],
)
```

Arguments must be in the hash, not just names: three `read_file` calls against `a.txt`, `b.txt`, `c.txt` is legitimate exploration of read-only state, not a stuck loop. Name-only hashing would false-positive on that sequence.

The inner list is **sorted** so a model that varies the emission order of parallel-safe tool calls between iterations — `[search, fetch]` then `[fetch, search]` with otherwise-identical args — still produces the same fingerprint. The fingerprint asks "did this iteration do the same work as the previous one?" — emission order isn't part of the work, so it shouldn't be part of the hash.

If three consecutive iterations produce the same fingerprint AND none of those iterations' tool calls produced an observable side effect (file write, memory retain, API mutation — tracked by `ToolSpec.sideEffectful: boolean`), the loop trips:

- Loop exits with `{ kind: "degraded", reason: "stuck_loop" }`
- Orchestrator posts the degraded reply
- `conversation/degraded` event carries `subtype: "stuck_loop"`

The hard cap `DEFAULT_MAX_ITERATIONS = 20` remains as the backstop. Hitting it also trips a degrade with `reason: "iteration_cap"`.

## Telemetry `[proposed]`

Every repair attempt and every degrade decision emits a structured log line (Pino `logger.warn`, **not** an Inngest event — these do not transit `step.sendEvent` and need no idempotency `id`):

```typescript
{ event: "agent.repair", subtype, instructions: { kind: "continuation_prompt" | "json_repair" | "feedback_injection" | "disable_stream" } }
{ event: "agent.degrade", reason, subtype? }
```

The durable Inngest signal is `conversation/degraded` (emitted once per degraded turn from inside the persist step — see "Degraded reply" above). The structured logs are the per-attempt forensic record. The evolution failure-reflector subscribes to the Inngest event and can join the logs by `runId` + `conversationId` for subtype-level analysis.

## Where the layers compose `[proposed]`

```
Inngest function `handle-message`             (Class A retries: 2)
  └── runStreamingAgentLoop                   (Class C/D repair budget: 1)
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

1. **Repair budget granularity.** Per-turn (current design) keeps the budget at the Inngest invocation boundary. Per-conversation would catch "this conversation keeps repairing" without an extra signal but risks letting one bad model burn budget across many turns. Default: per-turn.
2. **Degraded turn persistence shape.** Today the design persists only the final degraded reply plus the successful intermediate iterations. A `repair_attempts JSONB` column on `messages` (or a sibling table) would let the failure-reflector query historically by SQL. In the interim the `agent.repair` / `agent.degrade` structured logs (see [Telemetry](#telemetry-proposed)) carry the same forensic data — the reflector can join logs to events by `runId` + `conversationId` without an extra column. Defer the column until SQL access is needed.
3. **`conversation/degraded` status separation.** A separate `'degraded'` enum value wouldn't intrinsically gate anything — gating would come from a status check we'd have to add to `handle-message`'s entry guard (mirroring the existing `if (conv.status === "errored") return skipped` block). The real choice is what that gate should do: (a) auto-flip back to `active` on the next inbound (no behavioral change vs. the current design, just a different bookkeeping shape), or (b) require an explicit reset (friction, but lets the user acknowledge the failure before continuing). No major framework introduces a `degraded` conversation status — OpenAI Threads keep thread-level state binary with run-level status enums; Letta tracks per-step `stop_reason` not conversation-level health; CrewAI / AutoGen rely on event signals only. Default: stay `active` with the event signal, follow the industry pattern.
4. **Repair telemetry as steering signal.** If specific subtypes recur for specific models, the evolution failure-reflector could propose a steering rule ("prefer Sonnet for `schedule_task`"). Out of scope here; lives in [evolution.md](evolution.md).

## Related docs `[confirmed]`

- [crash-recovery.md](crash-recovery.md) — Inngest durability. The repair budget lives inside one Inngest invocation; the durability map is unchanged.
- [agents.md](agents.md) → Tool Architecture — the `is_error: true` `tool_result` channel used here for schema-validation feedback.
- [providers.md](providers.md) — `FallbackLlmProvider` and Class A handling.
- [transport/streaming.md](transport/streaming.md) — degraded replies use the same delivery path as normal replies.
- [evolution.md](evolution.md) → failure-reflector — consumes `conversation/errored` and `conversation/degraded`.
