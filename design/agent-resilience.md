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

## Class C: in-loop repair `[proposed]`

### Classifier

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

### Repair budget

One repair attempt per turn, shared across all Class C subtypes. The counter is on the turn boundary (one Inngest invocation of `handle-message`), not per iteration of the agent loop. A turn that hits an empty-content failure, repairs, then hits a JSON parse failure on the repaired turn degrades — it does not get a second repair.

The repair runs inside the same Inngest invocation. The outer `retries: 2` remains exclusively for Class A. A Class A retry that succeeds gets a fresh Class C budget because each Inngest invocation is logically a new turn from the user's perspective.

### Per-subtype repair

| Subtype | Repair |
|-|-|
| Empty `content` + `end_turn` | Append a user turn with a continuation nudge ("Please complete your response."). Per Anthropic's [stop-reason guidance](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), naive same-prompt retry does not help — the continuation prompt is the documented recovery. |
| Truncated / invalid JSON in tool-arg stream | Run `jsonrepair` on the buffered chunks before declaring failure. If repair produces valid JSON, validate against Zod and proceed. If repair fails, escalate to feedback-injection. |
| Tool-arg validation failure (Zod fails after coercion + repair) | Append an `is_error: true` `tool_result` with the validation message — the same channel handler exceptions already use (`loop.ts:265-270`) — and let the LLM see the error in its next iteration. |
| `chatTyped` structured-output schema failure | Append the validation error as a user turn, re-request with the same schema. |
| Stream truncated mid-`tool_use` (`stop_reason: "max_tokens"` with partial JSON) | Replay non-streaming with the same params. Single-shot token budget often completes where the chunked stream did not. |

### Degraded reply

When the budget exhausts or the classifier returns `degrade`, the orchestrator posts a single user-visible assistant message:

> I had trouble generating a clean response — the model returned an output I couldn't process. Could you rephrase or try again?

The degraded reply is persisted as a normal assistant message (role `assistant`, single `text` block). Conversation status stays `active`. `conversation/degraded` is emitted from inside the orchestrator's durable persist step, so the wrapping `step.run` provides exactly-once delivery (same pattern as `conversation/errored` in `onFailure`) — no explicit idempotency `id` needed.

**Persistence boundary on a degraded turn:**

- Successful intermediate iterations (tool_use + tool_result pairs whose handlers ran to completion, including their side effects) **are** persisted. Their tool calls already affected the world — file writes, memory retains, image generations — and the conversation transcript must reflect that.
- The single iteration whose response triggered the degrade — empty content, malformed JSON, schema-invalid output — is **not** persisted. That assistant message would be useless in history and risks feeding the model its own broken output on the next turn.
- The degraded reply is persisted as the final assistant message of the turn.

The forensic record of *what the model produced before degrading* lives in the `agent.repair` / `agent.degrade` structured logs (see Telemetry below), not in `messages`. The `messages` table is the conversation transcript; structured logs are the failure audit.

## Class D: loop pathology `[proposed]`

Each loop iteration produces a fingerprint:

```
hash(
  sorted [(tool_use.name, sha256(canonical-json(tool_use.input)))],
  last assistant text prefix [256 chars],
)
```

Arguments must be in the hash, not just names: three `read_file` calls against `a.txt`, `b.txt`, `c.txt` is legitimate exploration of read-only state, not a stuck loop. Name-only hashing would false-positive on that sequence.

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

- SDK adapters retry on HTTP-level transient codes only.
- `FallbackLlmProvider` tries next provider on Class A; propagates Class B; treats Class C parse failures as **non-retriable** (no `status` field but explicitly tagged `ProviderProtocolError`) so they reach the in-loop classifier instead of burning the provider chain.
- The in-loop classifier owns all Class C/D handling.
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
2. **Degraded turn persistence shape.** Today the design persists only the final degraded reply. A `repair_attempts JSONB` column on `messages` (or a sibling table) would let the failure-reflector see what the model originally produced. Defer until the reflector needs the input.
3. **`conversation/degraded` status separation.** Keeping conversation `active` lets the user immediately retry. Introducing a `'degraded'` status would gate the next inbound on an acknowledgment, which is friction. Default: stay `active`.
4. **Repair telemetry as steering signal.** If specific subtypes recur for specific models, the evolution failure-reflector could propose a steering rule ("prefer Sonnet for `schedule_task`"). Out of scope here; lives in [evolution.md](evolution.md).

## Related docs `[confirmed]`

- [crash-recovery.md](crash-recovery.md) — Inngest durability. The repair budget lives inside one Inngest invocation; the durability map is unchanged.
- [agents.md](agents.md) → Tool Architecture — the `is_error: true` `tool_result` channel used here for schema-validation feedback.
- [providers.md](providers.md) — `FallbackLlmProvider` and Class A handling.
- [transport/streaming.md](transport/streaming.md) — degraded replies use the same delivery path as normal replies.
- [evolution.md](evolution.md) → failure-reflector — consumes `conversation/errored` and `conversation/degraded`.
