# Crash Recovery `[confirmed]`

How `handle-message` survives worker crashes, what re-executes on resume, and why some side effects intentionally re-run.

## The Inngest model in one paragraph `[confirmed]`

Inngest does not pause and resume coroutines. It re-invokes the entire function over the wire for each step boundary. The SDK matches each `step.run("id", ...)` against state stored on the Inngest server and, if the ID is already in the state, returns the cached value **without calling the body**. Code outside `step.run` runs on every invocation. "Crash recovery" therefore means: on retry, durable steps replay from the state store; everything else re-executes from the top of the function.

This has two consequences:

1. **Side effects inside `step.run` are exactly-once across retries.** Inserting a row, sending an event via `step.sendEvent`, calling an LLM via `step.run` — all run once, then their results are cached.
2. **Side effects outside `step.run` are at-least-once.** They re-execute on every retry. If a developer accidentally puts a DB write or an API call in the bare function body, it will fire repeatedly.

The bug class to catch is #2. The contract below makes #1 vs #2 explicit for `handle-message`.

## `handle-message` durability map `[confirmed]`

| Phase | Step ID | Body | Side effect | Replays from cache |
|-|-|-|-|-|
| Load | `load-conversation` | `agentStore.getConversation` | DB read | ✓ |
| Load | `last-assistant` | `agentStore.getLastAssistantMessage` | DB read | ✓ |
| Load | `load-inbound` | `transportStore.getUnbatchedInbound` | DB read | ✓ |
| Persist | `create-user-message` | `agentStore.insertMessage` (user) | **DB write** | ✓ |
| Load | `load-history` | `agentStore.getHistory` | DB read | ✓ |
| Load | `assemble-prompt` | `promptSource.assemble` | DB read + assembly | ✓ |
| **Compact** | *(none — runs on every invocation)* | `compactMessages` (token count, clear, summarize, truncate) | token counting + decision | ✗ |
| Compact | `summarize-prefix` (conditional) | `provider.chat` for prefix summarization | **LLM call** | ✓ |
| **Streaming** | *(none — not in a step)* | image resolution, `memory.recall`, `getProfile`, `deliveryRouter.prepare`, `runStreamingAgentLoop`, tool execution, `delivery.finish` | **LLM stream + tool side effects** | ✗ |
| Persist | `persist-new-messages` | `agentStore.insertMessages` (batch INSERT: intermediate tool turns + final assistant, single transaction) | **DB write** | ✓ |
| Deliver | `batch-delivery` (conditional) | image resolution via `Promise.allSettled` + `delivery.deliverBatch` | **S3 GET + network send to batch adapters** | ✓ |
| Notify | `send-response` | `step.sendEvent("response/ready")` | Inngest event | ✓ |
| Resume | `flush` (conditional) | `step.sendEvent("inbound/ready")` | Inngest event | ✓ |

The non-durable regions are:

- **`compactMessages` orchestration.** Token counting and the threshold decisions are cheap and depend on `fullPrompt` / `historyMessages`, which are partially built from non-durable reads (`memory.recall`, image resolution). Caching the orchestration would freeze the compaction decision against potentially stale inputs and force base64 image payloads into Inngest state. Only the expensive summarization LLM call is durable — see "Why only summarization is durable" below.
- **Streaming.** You cannot stream events out of `step.run` — a step returns a single JSON-serializable value at the end. To deliver tokens to Telegram as they arrive, the LLM call has to happen in the bare function body. See [transport/streaming.md](transport/streaming.md) → "Orchestrator Changes".

**Batch delivery is durable.** The `batch-delivery` step runs *after* the non-durable streaming section completes and the assistant message is persisted, so it doesn't inherit the streaming constraint. Wrapping it gives exactly-once `sendMessage` / `sendPhoto` to batch adapters on retry + observability in the Inngest UI. Generated-image bytes flow through the step body in memory; the return value is only a small `{ delivered, failed }` record, so state stays lean. The step is gated by `delivery.hasBatchTargets()` — for pure-streaming setups (Telegram-only), the block is skipped entirely and no S3 downloads happen.

## Why only summarization is durable `[confirmed]`

The compaction pipeline (`compactMessages`) has two kinds of work:

1. **Cheap, deterministic-ish:** count tokens, clear old tool results, decide whether to summarize, truncate. Pure functions over the inputs.
2. **Expensive:** the summarization LLM round trip — easily 5-10 seconds and a few cents of tokens.

Wrapping the entire pipeline in a `step.run` would:

- **Freeze the decision against stale inputs.** The pipeline closes over `fullPrompt` (built from `memory.recall`, non-durable) and `model`/`budget` (from `getProfile`, non-durable). If any of those change between attempts, the cached compacted history is consistent with the OLD inputs but the agent loop receives the NEW inputs.
- **Persist large image payloads.** By the time compaction runs, `historyMessages` may contain base64 `image` blocks for the latest inbound attachments (~150-700KB per Telegram photo). Storing that in step state on every image-bearing turn is wasteful.

Wrapping only the summarize callback avoids both. The cached value is just the summary text (a few KB). `compactMessages` runs on every retry, so token counting and decisions always reflect the actual inputs the agent loop will receive. If summarization triggers and the step has a cached value, the LLM call is skipped; otherwise it runs fresh.

The summarization step does close over `system` (the `fullPrompt` at call time) and `msgs` (the prefix slice), so the cached summary may technically have been generated against a slightly different system prompt than the current attempt. In practice this is fine: the prefix messages are stable (`history` is durable), and the summary content depends on those messages — not on the persona variation in the system prompt.

**Failure mode: when summarization itself fails.** If the summarize step body throws (LLM error, timeout), Inngest's per-step retries fire first. Once those exhaust, the rejection bubbles into `compactMessages`, which catches it (`context.ts`), logs a warning, and falls through to the truncation strategy. The function-level `retries: 2` does **not** see this failure — the function never throws. This is the deliberate design: truncation is a safe fallback (degraded context beats a failed turn), and the user gets a response on the same attempt. The honest framing of the contract is therefore "summarization is exactly-once **if it ever succeeds**" — if every retry fails, the conversation downgrades silently to truncation. If silent downgrade ever becomes a debugging problem, the fix is to surface compaction events (`logger.info` already emits `strategies` per turn) to a metrics sink.

## What this means in practice `[confirmed]`

### When the streaming section crashes

If `runStreamingAgentLoop` throws (network blip, API error, OOM):

1. Inngest catches the throw, marks the function as failed for this attempt, and re-invokes it (up to `retries: 2`).
2. On the new invocation:
   - Every durable step above the streaming section runs from cache. `create-user-message` returns its prior `void` result — **no double user-message insert**.
   - `compactMessages` re-runs from scratch (cheap). If summarization is triggered, `summarize-prefix` returns its cached summary text — **no double summarization LLM call**.
3. The streaming section re-runs from scratch:
   - `memory.recall` runs again (idempotent — pure read).
   - `attachments.download` re-fetches images (idempotent — pure read).
   - `runStreamingAgentLoop` makes new LLM calls and re-executes any tools the LLM picks.
4. If it succeeds this time, `persist-new-messages` runs (inserts all intermediate tool turns + final assistant), the response is delivered, and the function resolves.

The user observes a message that took longer than usual (one extra round of tool calls and LLM tokens), but never sees a corrupted conversation, never sees a duplicate user message, and never gets billed twice for summarization.

### Tool side effects that re-execute

The streaming section is where tools run, so tool side effects are at-least-once on retry **unless the tool opts into per-handler durability** (see "Per-tool durability" below). By tool:

| Tool | Re-execution behavior |
|-|-|
| `memory_recall`, `read_file`, `list_files`, `current_time` | Pure reads — free to repeat. |
| `web_search`, `fetch_url` | Wastes external API quota. Otherwise benign — results inform the next LLM call only. |
| `web_answer` | **Durable** — wrapped in `step.run` because Perplexity Sonar via OpenRouter is a billable LLM round-trip. Cached tool output replays on retry. |
| `memory_retain` | Writes the same fact twice. Hindsight's `reflect()` job dedupes downstream. |
| `core_memory_update`, `write_file` | Idempotent overwrites with the same content. No corruption. |
| `generate_image` | **Durable** — wrapped in `step.run` because fal.ai charges $0.02–$0.04/call and uploads to AttachmentStore. Cached JSON result (path + mediaType) replays on retry — no re-billing, no duplicate uploaded blobs. |

Net cost of a single retry: one extra LLM round-trip plus, in the worst case, a few duplicated external API calls on non-durable tools. Acceptable for v0.

### Per-tool durability

Individual tool handlers may opt into durability via `ToolSpec.durable = true`. When set, the agent loop wraps that specific handler invocation in `step.run("tool-iter<N>-<P>", fn)`, where `<N>` is the agent-loop iteration counter and `<P>` is the position of the block within that iteration's `tool_use` sub-list — i.e. the index after filtering out text/thinking blocks. Both indices are derived purely from SDK-local state — the loop counter increments by one per iteration of the same function invocation, and the position is a simple array index over the filtered list the SDK produced. They are byte-identical on every attempt regardless of what the LLM emits.

The LLM-minted `tool_use_id` (e.g. `toolu_01ABC`) is **not** stable across replays — the streaming LLM call is non-durable, so every Inngest retry calls the provider fresh and gets new ids. A step id keyed on `tool_use_id` would yield a different hash on each attempt; Inngest's planner pins the first attempt's hash, can't find a matching step on retry, and fails the run with `Could not find step <hash> to run; timed out`. The user sees a stalled turn followed by a silent 60s cooldown lockout from `recover-conversation`. Keying on `(iteration, position)` instead keeps the step graph in sync across attempts.

**Trade-off: semantic mismatch on cache hit.** The fix accepts that a cached step from attempt 0 may replay with content that doesn't match attempt 1's `tool_use`. Concretely: if attempt 0 cached `tool-iter1-0 = read_file("/A")` → `"contents A"`, and attempt 1's fresh LLM call emits `read_file("/B")` at position 0, the loop builds a `tool_result` with `toolUseId = <attempt 1's id>, content = "contents A"`. The Anthropic pairing invariant (every `tool_use` answered by a `tool_result` with matching id) holds, so no crash; the LLM sees "/B"'s tool_use answered by "/A"'s contents and is left to reason from incoherent context. In practice the same model on the same conversation produces consistent enough decisions that this rarely fires, and when it does, the agent's repair budgets and Class D loop-pathology detection bound the damage; the alternative (silent failure plus cooldown lockout) is strictly worse for the user.

The iteration counter itself can also diverge across attempts when Class C repairs fire asymmetrically — e.g., attempt 0 consumes iteration 1 on a `stream_truncation` continuation+repair before reaching its first tool call (`tool-iter2-0` cached), while attempt 1 streams cleanly and runs the same tool at `tool-iter1-0`. The fresh id doesn't match the cached one; Inngest simply doesn't hit the cache and the tool re-executes. Strictly safer than the deadlock the position-keyed scheme replaces, but it carries the same "double bill on `generate_image`" exposure as a fresh deploy — see the rollout note in the matching changelog fragment.

Cached failures behave correctly with Class D: if attempt 0's durable handler threw and Inngest cached the rejection, `stepRun` re-throws on attempt 1; the outer try/catch in `runOne` (`src/agent/loop.ts`) converts it to an `is_error: true` `tool_result`, which `iterationHadSideEffect` filters out, so a stuck-loop fingerprint doesn't credit the iteration with progress it never made.

The current chat path also runs with provider-default sampling (temperature unset, no seed) in `runStreamingAgentLoop` — see the `chatParams` construction in `src/agent/loop.ts`. Tightening sampling would shrink the divergence window further but is orthogonal to the step-id correctness fix; this section pins the correctness invariant only.

**Why not wrap the LLM call in `step.run` instead?** The "correct" alternative is to make `provider.chat` durable so the cached response — including its `tool_use_id`s — replays unchanged on retry; the original id scheme would then have worked. For the non-streaming `runAgentLoop`, this is trivial. But `runAgentLoop` has no production caller: `handle-message` exclusively uses `runStreamingAgentLoop`, and streaming cannot live inside `step.run` (a step returns a single JSON-serializable value at the end; tokens that need to reach Telegram as they arrive can't cross that boundary — see `transport/streaming.md` → Orchestrator Changes). A hybrid (stream on attempt 0, cache the final aggregated content blocks at iteration end, suppress `onEvent` re-emission on cached replay) is feasible but adds real protocol complexity around partial caches and partial deliveries; reserve for a later pass if the semantic-mismatch failure mode shows up in practice. For now, ordinal step ids buy correctness of the step graph without changing the streaming protocol.

See the unit regression test in `src/agent/loop.test.ts` ("emits identical step ids across attempts even when the LLM mints different tool_use ids") and the wire-level test in `src/agent/handle-message.replay.test.ts` ("durable tool step body is not re-executed when the iteration-keyed step is cached").

Handlers execute **between** stream events (after the stream iteration finishes for a turn, before the next `onEvent("tool_result")` emission). Wrapping a single handler in `step.run` therefore doesn't reorder `onEvent` emissions — it just turns a direct `await handler(...)` into an `await step.run(id, () => handler(...))`, awaited in exactly the same place in the loop. Stream-handle side effects still see events in the same order as without durability.

Use sparingly. Wrap only when the handler is expensive or billable (image generation, paid LLM round trips) — cheap/idempotent tools should stay non-durable so their results don't take up Inngest state. Current durable tools: `generate_image`, `web_answer`.

### Streaming dedup across the same process

`deliveryRouter.prepare()` re-runs on retry and would normally call `openStream()` again, creating a second Telegram message. Streaming adapters dedupe via the Inngest `runId` (stable across retries of the same invocation):

```typescript
// TelegramAdapter
#activeStreams = new Map<string, TelegramStreamHandle>();

async openStream(platformAddress, runId) {
  const existing = this.#activeStreams.get(runId);
  if (existing) return existing; // retry — reuse the existing Telegram message
  // ... create new ...
}
```

The map lives in memory in the long-running Inngest connect-mode worker, so it survives within-process retries. See [transport/streaming.md](transport/streaming.md) → "Retry Deduplication".

### Process death

If the entire Node process dies (OOM, supervisor kill) and a different worker picks up the retry:

- Durable steps still replay correctly — they live in Inngest's state store, not in process memory.
- The streaming dedup map is lost. The new worker creates a fresh Telegram message; the old one is orphaned (its message ID is unrecoverable). The user sees a duplicate.

This is documented as accepted in `transport/streaming.md`. Cross-process stream resumption would require persisting `(runId → platform message ID)` to the DB before any tokens are sent. Out of scope for v0; revisit if process deaths become common.

## Test coverage `[confirmed]`

`src/agent/handle-message.replay.test.ts` exercises the durability contract via `@inngest/test`'s `steps:` mechanism, which is Inngest's memoization model exposed for tests. Each test provides a step in `steps:` to simulate "this step already ran in a prior attempt" and asserts the step body's side effects do not repeat.

The four cases:

1. `create-user-message` cached → no user-role `insertMessage` call.
2. `persist-new-messages` cached → no `insertMessages` call (no persistence of any new messages: tool turns + assistant).
3. `summarize-prefix` cached → no `provider.chat` call for summarization, and the cached summary text appears in the history passed to the agent loop (non-vacuity check).
4. All listed durable steps cached → `runStreamingAgentLoop` is still called (canary for the non-durable contract).

The fourth test is the regression guard for the bug class. If a developer ever wraps the agent loop in `step.run` to "make it durable", the test still passes — but the streaming behavior breaks at runtime. The inverse mistake (moving a side effect *out* of a step) would be caught by tests 1-3 because the side effect would suddenly be observable.

**Why only side-effectful steps get individual tests.** Tests 1-3 cover the steps where re-execution would cause concrete harm (duplicate DB writes, duplicate LLM round trips). The pure-read steps (`load-conversation`, `last-assistant`, `load-inbound`, `load-history`, `assemble-prompt`) are exercised collectively by test 4 and aren't worth individual coverage: if one of them accidentally moved out of `step.run`, the only consequence on retry would be a wasted DB query, not corruption. The cost-of-bug is too low to justify a test per read.

For **wire-level** crash recovery (real Inngest server, real retries, side-effect counters across actual HTTP re-invocations) we rely on Inngest itself — that path is library-tested upstream and our integration test in `pipeline.integration.test.ts` proves the full end-to-end works against a real dev server. We do not currently simulate a forced crash there; if recovery bugs surface in practice, the right escalation is an integration test that throws on first attempt and asserts the second attempt completes.

## State serialization `[confirmed]`

Inngest stores step return values via JSON, so anything returned from a `step.run` body must round-trip through `JSON.stringify` / `JSON.parse` losslessly. The only step that returns user-supplied data is `summarize-prefix`, which returns a `string` — trivially safe.

For future steps that return `Message[]` or `ContentBlock[]`, the type contract guarantees JSON safety:

- `ImageBlock.data` is `string` (base64 or URL), never a `Buffer` — `attachments.download()` returns a Buffer but `handle-message` immediately calls `.toString("base64")` before placing the bytes in any block.
- `ToolUseBlock.input` is `unknown` but only ever holds JSON-parsed LLM output.
- `ToolResultBlock.content` is `string`.

If a future change introduces a binary field anywhere in `ContentBlock`, it must be encoded to a string before reaching any `step.run` return path. The type system will not catch this — `unknown` accepts anything — so the rule lives here.

## Adding a new durable boundary `[confirmed]`

Wrap a side effect in `step.run` when **all** of these are true:

- The work is a single observable side effect (DB write, LLM call, external API call) — not a streaming pipeline.
- The result is small and JSON-serializable (so Inngest can store it and replay it).
- Re-executing it would be expensive, wrong, or visible to the user.
- The step's inputs are themselves durable, OR the cached output remains valid even if the inputs drift slightly between attempts. Otherwise the cache freezes against stale inputs.

Do **not** wrap:

- Pure reads from injected dependencies (cheap, idempotent).
- Code that captures references to the streaming `delivery` handle and expects to push events on every invocation.
- The agent loop itself (`runStreamingAgentLoop`) — the loop body must stay in the non-durable section so tokens can stream out. Individual tool handlers *inside* the loop are the exception: they run between stream events and can be wrapped via `ToolSpec.durable = true` (see "Per-tool durability" above).
- Pipelines that build large intermediate values (image base64, full message histories) just to return a small final result. Wrap only the expensive sub-step.

When adding a new step, add a corresponding case to `handle-message.replay.test.ts` proving the body does not re-execute on cached replay.
