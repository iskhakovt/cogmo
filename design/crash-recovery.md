# Crash Recovery `[confirmed]`

How `handle-message` survives worker crashes, what re-executes on resume, and why some side effects intentionally re-run.

## The Inngest model in one paragraph `[confirmed]`

Inngest does not pause and resume coroutines. It re-invokes the entire function over the wire — **at every step boundary, on success, not just on retry**. The SDK matches each `step.run("id", ...)` against state stored on the Inngest server and, if the ID is already in the state, returns the cached value **without calling the body**. Code outside `step.run` runs on every invocation, so a function with N steps executes its bare body up to N+1 times on a clean run.

SDK v4's checkpointing usually collapses that: sequential steps execute in one request, with results checkpointed in the background. But checkpointing is an *optimization with documented fallbacks*, not the contract — the SDK drops back to one-invocation-per-boundary orchestration whenever it hits parallel steps (`Promise.all` over durable tools does this every time), a step failure/retry, a lease migration, or the connect-mode `maxRuntime` (300s of continuous execution). Design every function for the per-boundary model; treat single-request execution as a bonus.

This has two consequences:

1. **Side effects inside `step.run` are exactly-once across replays and retries.** Inserting a row, sending an event via `step.sendEvent`, calling an LLM via `step.run` — all run once, then their results are cached. Side effects *emitted from inside a step body* (streaming tokens to a transport, pushing a status banner) fire live on the execution and are suppressed on replay — only the *return value* must be JSON-serializable, not the work.
2. **Everything outside `step.run` is at-least-once — typically once per remaining boundary.** A DB write, an API call, or an LLM call in the bare function body re-fires on every re-invocation. On the happy path. This is not a retry concern: a clean turn with three durable tool calls re-executes its bare body about four times.

The bug class to catch is #2 — and to catch it you have to **count boundaries, not retries**. The contract below makes #1 vs #2 explicit for `handle-message`.

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
| Compact | `summarize-prefix` (conditional) | status push + `provider.chat` for prefix summarization | **LLM call + stream push** | ✓ |
| Recall | `auto-recall` (conditional) | `service.memory.recall` (failure degraded to no-memories inside the body) | **embedding + vector search** | ✓ |
| **Streaming glue** | *(none — runs on every invocation)* | image resolution, `getProfile`, `deliveryRouter.prepare`, tool-registry assembly, `compactMessages` orchestration, the loop's control flow, `delivery.finish` | cheap reads + deterministic assembly | ✗ |
| Loop | `llm-iter<N>` (one per iteration) | stream drain + in-step Class C repair; tokens stream to the delivery layer live from inside the body | **LLM stream + emission** | ✓ |
| Loop | `tool-iter<N>-<P>` (per durable tool call) | the tool handler | **tool side effect** | ✓ |
| Loop | `emit-tool-results-iter<N>` (per tool-bearing iteration) | push the iteration's `tool_result` events to the delivery layer | **stream pushes (media cards)** | ✓ |
| Degrade | `degraded-reply` (conditional) | `synthesizeDegradedReply` + retract/apology pushes; returns the apology text | **LLM call + stream pushes** | ✓ |
| Persist | `persist-new-messages` | `agentStore.insertMessages` (batch INSERT: intermediate tool turns + final assistant, single transaction) | **DB write** | ✓ |
| Deliver | `batch-delivery` (conditional) | image resolution via `Promise.allSettled` + `delivery.deliverBatch` | **S3 GET + network send to batch adapters** | ✓ |
| Notify | `send-response` | `step.sendEvent("response/ready")` | Inngest event | ✓ |
| Resume | `flush` (conditional) | `step.sendEvent("inbound/ready")` | Inngest event | ✓ |

The non-durable regions are:

- **`compactMessages` orchestration.** Token counting and the threshold decisions are cheap relative to what a step would cost to freeze, and `historyMessages` carries resolved base64 image payloads that must not land in Inngest state. Its inputs are stable across invocations (durable history + durable `auto-recall` + deterministic image resolution), so every replay reaches the same verdicts. Only the expensive summarization LLM call is durable — see "Why only summarization is durable" below.
- **Streaming glue.** The loop's control flow, delivery-handle preparation, per-turn registry/service assembly, and image resolution re-run on every invocation. This is fine *because* everything expensive or emitting inside the loop is a step: the drain of each LLM iteration (including its live token emission) runs inside `llm-iter<N>`, so a replayed invocation walks the loop over cached outcomes without touching the provider or the user's screen. Note the once-believed constraint here — "you cannot stream out of `step.run`" — conflated two things: *returning* a stream from a step (impossible; the return value is a single JSON payload) and *emitting* to a transport from inside a step body (normal, and suppressed on replay, which is exactly the desired behavior). See "Durable LLM iterations" below.

**Batch delivery is durable.** The `batch-delivery` step runs *after* the non-durable streaming section completes and the assistant message is persisted, so it doesn't inherit the streaming constraint. Wrapping it gives exactly-once `sendMessage` / `sendPhoto` to batch adapters on retry + observability in the Inngest UI. Generated-image bytes flow through the step body in memory; the return value is only a small `{ delivered, failed }` record, so state stays lean. The step is gated by `delivery.hasBatchTargets()` — for pure-streaming setups (Telegram-only), the block is skipped entirely and no S3 downloads happen.

## Why only summarization is durable `[confirmed]`

The compaction pipeline (`compactMessages`) has two kinds of work:

1. **Cheap, deterministic-ish:** count tokens, clear old tool results, decide whether to summarize, truncate. Pure functions over the inputs.
2. **Expensive:** the summarization LLM round trip — easily 5-10 seconds and a few cents of tokens.

Wrapping the entire pipeline in a `step.run` would:

- **Freeze the decision against stale inputs.** The pipeline closes over `model`/`budget` (from `getProfile`, non-durable). If those change between attempts, the cached compacted history is consistent with the OLD inputs but the agent loop receives the NEW inputs. (`fullPrompt` is stable now that `auto-recall` is durable, which weakens this leg — the image-payload leg below still decides it.)
- **Persist large image payloads.** By the time compaction runs, `historyMessages` may contain base64 `image` blocks for the latest inbound attachments (~150-700KB per Telegram photo). Storing that in step state on every image-bearing turn is wasteful.

Wrapping only the summarize callback avoids both. The cached value is just the summary text (a few KB). `compactMessages` runs on every retry, so token counting and decisions always reflect the actual inputs the agent loop will receive. If summarization triggers and the step has a cached value, the LLM call is skipped; otherwise it runs fresh.

The summarization step does close over `system` (the `fullPrompt` at call time) and `msgs` (the prefix slice), so the cached summary may technically have been generated against a slightly different system prompt than the current attempt. In practice this is fine: the prefix messages are stable (`history` is durable), and the summary content depends on those messages — not on the persona variation in the system prompt.

**Failure mode: when summarization itself fails.** If the summarize step body throws (LLM error, timeout), Inngest's per-step retries fire first. Once those exhaust, the rejection bubbles into `compactMessages`, which catches it (`context.ts`), logs a warning, and falls through to the truncation strategy. The function-level `retries: 2` does **not** see this failure — the function never throws. This is the deliberate design: truncation is a safe fallback (degraded context beats a failed turn), and the user gets a response on the same attempt. The honest framing of the contract is therefore "summarization is exactly-once **if it ever succeeds**" — if every retry fails, the conversation downgrades silently to truncation. If silent downgrade ever becomes a debugging problem, the fix is to surface compaction events (`logger.info` already emits `strategies` per turn) to a metrics sink.

## What this means in practice `[confirmed]`

### Durable LLM iterations

Each pass of `runStreamingAgentLoop` runs its model call inside `step.run("llm-iter<N>")`, where `<N>` is the SDK-local iteration counter. The step body drains the stream — forwarding `text_delta` / `tool_start` events to the delivery layer live as they arrive — and returns a JSON `LlmIterationOutcome`: the reconstructed content blocks, stop reason, usage, whether the in-step Class C repair consumed a budget, and an `emitted` ledger of exactly what was forwarded. On a replayed invocation the cached outcome reproduces the iteration bit-for-bit with **no provider call and no re-emission**.

What this buys, per failure mode:

| Problem | Why it goes away |
|-|-|
| N× token spend per turn | The model is billed once per iteration, not once per iteration per remaining boundary |
| Duplicate streamed preambles | Memoized step ⇒ no re-emission; the `#activeStreams` handle only ever sees each token once |
| `step-not-found` run failures | Cached content ⇒ identical tool_use blocks ⇒ identical downstream step graph on every replay |
| Semantic mismatch on tool cache hits | A replayed iteration cannot emit a different tool at the same position |

**Class C lives inside the step body.** `classifyStreamError` and the non-streaming replay run inside `llm-iter<N>` and come back as *data* (`repaired` / a degrade outcome), not as throws. A `ProviderProtocolError` that escaped the body would be blind-retried by Inngest (bypassing the repair budgets) and would eventually surface wrapped in Inngest's step-failure error, where `instanceof` classification can no longer see it. Only Class A errors (network, 5xx — where a blind retry is the correct treatment) throw; they fail the step and Inngest's per-step retries own them. Budget decrements happen in the loop, driven by the returned outcome, so replays recompute identical budget state from the cache.

**Tool_result emission is its own step (`emit-tool-results-iter<N>`).** The bare-body continuation after a `Promise.all` of steps is the wrong place for a push: Inngest executes a parallel group's bodies in *targeted* requests that run only the step body (and once a run has seen parallel steps, `disableImmediateExecution` pins even single steps to that pattern), so the continuation only ever runs in later, fully-memoized invocations. A bare-body emission there is deterministically lost for durable tools — no invocation both runs the body and reaches the emission — and repeated once per re-invocation for non-durable tools, whose handlers re-run every time. Wrapping the pushes in a step makes the emission exactly-once: live in the invocation whose targeted request runs the body, suppressed on every replay. For non-durable tools the emitted content is the emitting invocation's execution — the same accepted drift as persistence.

**The `streamed` ledger.** `AgentLoopResult.streamed` (all forwarded text + tool_start ids) is rebuilt from the cached `emitted` ledgers, so the orchestrator's degraded-turn retraction sees the same picture on every invocation. An orchestrator-side ledger of live emissions would come back empty on a replay whose iterations all came from cache — and the retraction would silently no-op.

**What a mid-step crash still costs.** If the process dies mid-stream the step never completed, so the retry re-runs the body and re-streams from the top of that iteration (and re-bills it — inherent to any retry of a failed attempt). The runId-keyed `#activeStreams` dedup turns the re-stream into edits of the same message. Durable steps cover the boundary-replay path; the dedup map covers the crash path. Keep both. Three narrower crash-window residuals, all accepted:

- *Duplicated in-body pushes on step retry.* If a step body fails after some of its pushes (the `summarize-prefix` status banner, the `degraded-reply` apology, a partially-emitted `emit-tool-results-iter<N>`), the per-step retry re-runs the body and pushes again. Media dedups by path at the handle; text banners and non-media cards may append twice. Cosmetic, and bounded by the step's retry budget.
- *File-freshness cache after process death.* `createFileService`'s read-before-mutate gate lives in a process-lifetime map. A cross-process replay re-populates it via non-durable `read_file` re-execution, except for a file first *created* by a cached `write_file` in the same turn — a follow-up `edit_file` then errors with "read the file first", which is itself the recovery instruction: the model re-reads and retries. Self-healing; not worth persisting the cache.

**Bare-body cost scales with the boundary count.** Durable iterations and durable tools took a turn from roughly 4 bare-body executions to roughly `3×iterations + tools + 4`, and everything left in the streaming glue pays that multiplier. The one that is not merely cheap is inbound attachment resolution: `attachments.download()` is an S3 GET plus a base64 encode per image, so a 5-iteration turn carrying a photo does ~15 of each. It is an idempotent read, so it is correct — but "idempotent" is a correctness claim, not a cost one. Tracked as a `p2` in `todo.md` (per-run LRU keyed by attachment path; deliberately not step state, since the payloads are exactly what must stay out of Inngest's store).

**Residual non-determinism (accepted).** Non-durable tool results still re-execute per invocation, and a result that *changes* between invocations (an error flipping to success) feeds Class D's side-effect gate — in the worst case a replay could reach a different degrade verdict than the live pass and diverge the step graph. This needs a non-durable tool to flip its error status between two invocations seconds apart *at* a Class D boundary; side-effectful and billable tools are durable (below), which removes the likely flippers. Documented, not defended.

### When the streaming section crashes

If the loop throws a Class A error (network blip, 5xx, OOM):

1. The error escapes the `llm-iter<N>` body and fails the step; Inngest's per-step retries re-run just that iteration (every earlier step — including earlier iterations — replays from cache).
2. On each re-invocation, the streaming glue re-runs from scratch: `attachments.download` re-fetches images (idempotent read), `deliveryRouter.prepare` reuses the runId-keyed handle, the loop walks its cached outcomes.
3. Deterministic 4xx provider errors short-circuit: the injected `stepRun` wrapper converts them to `NonRetriableError` inside the step body, so the run fails to `onFailure` immediately instead of burning retries.
4. If the retried iteration succeeds, the turn continues; `persist-new-messages` inserts everything exactly once.

The user observes a message that took longer than usual, but never sees a corrupted conversation, never a duplicate user message, and is never re-billed for completed iterations, summarization, or durable tools.

### Tool durability policy

Tool handlers run in the loop, in the bare body unless marked durable — so a non-durable handler re-executes **once per remaining step boundary of the turn**, not merely on retry. That count is what decides the flag:

**Durable (side-effectful or billable — exactly-once per turn):** `generate_image`, `web_answer`, `web_search`, `fetch_url`, `memory_recall`, `memory_reflect`, `memory_retain`, `write_file`, `edit_file`, `core_memory_update`, `schedule_task`, `remove_task`, `activate_pipeline`, `define_pipeline`, `delegate_coding`, `register_skill`, `send_document`, every `subagent__*` tool, and every MCP tool (`src/mcp/adapter.ts`).

**Non-durable (cheap idempotent reads whose output may be large or is trivially recomputed):** `read_file`, `list_files`, `list_tasks`, `list_pipelines`, `core_memory_read`, `current_time`. Re-execution costs a local read; keeping their possibly-large outputs out of Inngest state matters more. Accepted drift: the *persisted* `tool_result` for these is whatever the **last** invocation's re-execution returned, which can differ from what the model saw live (e.g. a file changed mid-turn).

Marking a tool `durable: true` is a cost decision with two sides: it buys exactly-once for the handler and pins the recorded `tool_result` to what the model actually saw, and it charges one extra step boundary — which, with LLM iterations durable, costs a cheap cached replay rather than a fresh model call. Justify both sides in the PR that flips a flag.

#### The crash window each durable tool still carries

`durable: true` buys replay-safety, not exactly-once: the body still runs at least once, and a crash between its side effect committing and Inngest recording the step result re-runs it. Closing that needs a caller-supplied idempotency key with somewhere to attach it. The loop mints one per call (`ToolCallContext.idempotencyKey`, see [Per-tool durability](#per-tool-durability)); whether a tool can use it depends on whether its side effect has a dedup point.

| Tool | Crash-window disposition |
|-|-|
| `delegate_coding` | **Keyed** — `coding_tasks.idempotency_key`, plain `UNIQUE` + `ON CONFLICT DO UPDATE` with a no-op SET and an `xmax = 0` discriminator (see `.claude/rules/inngest.md` for why `DO NOTHING` can't resolve a concurrent loser under REPEATABLE READ). A duplicate would mint a second sandbox, a second billable claude session and a second PR. |
| `schedule_task` | **Keyed** — `scheduled_tasks.idempotency_key`. The worst duplicate on this list: it fires on every tick from then on, and only an explicit `remove_task` stops it. |
| skill tools (`buildSkillToolSpec`) | **Keyed** — forwarded to `runner.invoke`, which drives the `skill_runs` `recovery_point` state machine. |
| `register_skill` | Self-deduping — a register against an unchanged branch tip resolves as `no_op` rather than a second deploy. |
| `activate_pipeline` | Naturally idempotent — activation is a state, not an event; re-activating the same version converges. |
| `define_pipeline` | Residual: a retry compiles again (re-billed) and saves a second definition version. Versions are immutable and inert until activated, so the cost is a stray row plus one compile. |
| `write_file`, `core_memory_update` | Naturally idempotent — last-writer-wins on identical content. |
| `edit_file` | Self-protecting — the second apply finds its match already replaced and errors rather than double-applying. |
| `memory_retain` | Absorbed — memory writes are additive by design and `reflect()` dedups asynchronously. |
| `remove_task` | Naturally idempotent — deleting an already-deleted row is `not_found`. |
| `web_search`, `web_answer`, `fetch_url`, `memory_recall`, `memory_reflect`, `subagent__*` | Reads and generations with no persistent duplicate state. Durable because billable; a crash retry costs one extra call. No upstream idempotency slot to key on. |
| `generate_image`, `send_document` | Residual: a retry re-bills the generation and can deliver a second copy. The delivery layer's `#activeStreams` dedup covers the streamed path, not a batch send. |
| MCP tools | Residual, unclosable here: the MCP tool contract has no idempotency-token slot. `ToolCallContext` is available to forward the day a server accepts one. |

The residuals are accepted at single-user scale, and all of them fail in the safe direction — a duplicate the user can see, never a silently-dropped request.

### Per-tool durability

Individual tool handlers may opt into durability via `ToolSpec.durable = true`. When set, the agent loop wraps that specific handler invocation in `step.run("tool-iter<N>-<P>", fn)`, where `<N>` is the agent-loop iteration counter and `<P>` is the position of the block within that iteration's `tool_use` sub-list — i.e. the index after filtering out text/thinking blocks. Both indices are derived purely from SDK-local state — the loop counter increments by one per iteration of the same function invocation, and the position is a simple array index over the filtered list the SDK produced. They are byte-identical on every attempt regardless of what the LLM emits.

The step id must never derive from model output. The LLM-minted `tool_use_id` (e.g. `toolu_01ABC`) is stable across *boundary replays* now that the iteration content is cached, but it is NOT stable across a **mid-step retry** — a crash inside `llm-iter<N>` re-runs the drain, the provider mints fresh ids, and the non-streaming `runAgentLoop` never had iteration steps at all. A step id keyed on `tool_use_id` would yield a different hash on those paths; Inngest's planner pins the first attempt's hash, can't find a matching step, and fails the run with `Could not find step <hash> to run; timed out` — a stalled turn plus a silent 60s cooldown lockout from `recover-conversation`. Keying on `(iteration, position)` keeps the step graph in sync regardless of what the model emits.

**Semantic mismatch on cache hit — now confined to the mid-step-crash path.** With iteration outcomes cached, a boundary replay reproduces the exact tool_use blocks, so a cached `tool-iter<N>-<P>` always pairs with the same call that produced it. The mismatch (attempt 0 cached `tool-iter1-0 = fetch_url("/A")` → attempt 1's fresh drain emits `fetch_url("/B")` at position 0, which replays "/A"'s contents) survives only when the *iteration step itself* re-ran — i.e. a crash mid-`llm-iter<N>` after a durable tool of that iteration had completed. The Anthropic pairing invariant holds (the `tool_result` is rebuilt with the current attempt's id), the repair budgets and Class D bound the damage, and the alternative (step-not-found plus cooldown lockout) remains strictly worse.

The same reasoning covers Class C asymmetry across attempts: iteration numbering is derived from cached outcomes, so it can only shift on a mid-step retry, where an unmatched `tool-iter<N>-<P>` id simply misses the cache and the tool re-executes — the double-bill exposure, not a deadlock.

Cached failures behave correctly with Class D: if attempt 0's durable handler threw and Inngest cached the rejection, `stepRun` re-throws on attempt 1; the outer try/catch in `runOne` (`src/agent/loop.ts`) converts it to an `is_error: true` `tool_result`, which `iterationHadSideEffect` filters out, so a stuck-loop fingerprint doesn't credit the iteration with progress it never made.

The chat path runs with provider-default sampling (temperature unset, no seed) — see the `chatParams` construction in `src/agent/loop.ts`. With iterations durable this only matters on the mid-step-crash path; pinning sampling would shrink that window further and is tracked as optional hardening.

The LLM call itself IS durable — see "Durable LLM iterations" above. (An earlier revision of this section argued it couldn't be, on the premise that streaming can't cross a `step.run` boundary; that premise confused returning a stream from a step with emitting to a transport from inside the body. The emission works, and its suppression on replay is the fix for duplicate streamed output.)

See the unit regression tests in `src/agent/loop.test.ts` ("emits identical step ids across attempts even when the LLM mints different tool_use ids", the "durable LLM iterations (stepRun)" describe block) and the wire-level tests in `src/agent/handle-message.replay.test.ts` ("durable tool step body is not re-executed when the iteration-keyed step is cached", "does not call the provider when the llm-iter1 step is cached").

Handlers execute **between** stream events (after the stream iteration finishes for a turn, before the next `onEvent("tool_result")` emission). Wrapping a single handler in `step.run` therefore doesn't reorder `onEvent` emissions — it just turns a direct `await handler(...)` into an `await step.run(id, () => handler(...))`, awaited in exactly the same place in the loop. Stream-handle side effects still see events in the same order as without durability.

The flag policy — which tools are durable and why — lives in "Tool durability policy" above.

### Streaming dedup across the same process

`deliveryRouter.prepare()` re-runs on every re-invocation — each step boundary, plus retries — and would normally call `openStream()` again, creating a second Telegram message. Streaming adapters dedupe via the Inngest `runId` (stable across all invocations of the same run):

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
- The streaming dedup map is lost, and with it everything the old handle held: buffered sub-500ms-throttle deltas that were never flushed to Telegram, and the knowledge of what was already delivered. The new worker's fresh handle receives only what the REMAINING live steps push — completed iterations replay from cache without re-emitting. The visible symptom is a truncated turn on the user's screen with a complete transcript in the DB: mid-turn, the tail of the reply streams into a new message while the head stays in the orphaned one; after all steps completed, nothing more is pushed at all. Pushes that happened inside now-cached step bodies (the `degraded-reply` retraction/apology, `emit-tool-results-iter<N>` cards) are likewise not re-issued — a retraction that was buffered but unflushed when the process died is permanently lost.

This is documented as accepted (same trigger class as before durable iterations — process death — with the symptom flipped from "duplicate message" to "missing tail"). Cross-process stream resumption would require persisting `(runId → platform message ID)` plus a delivered-cursor to the DB before tokens are sent. Out of scope for v0; revisit if process deaths become common. Note the corollary: the streaming UX now assumes a single long-lived worker per run — routine multi-invocation turns spread pushes across invocations, and only the in-process handle stitches them into one message.

## Test coverage `[confirmed]`

`src/agent/handle-message.replay.test.ts` exercises the durability contract via `@inngest/test`'s `steps:` mechanism, which is Inngest's memoization model exposed for tests. Each test provides a step in `steps:` to simulate "this step already ran in a prior attempt" and asserts the step body's side effects do not repeat.

The cases:

1. `create-user-message` cached → no user-role `insertMessage` call.
2. `persist-new-messages` cached → no `insertMessages` call (no persistence of any new messages: tool turns + assistant).
3. `summarize-prefix` cached → no `provider.chat` call for summarization, and the cached summary text appears in the history passed to the agent loop (non-vacuity check).
4. All listed durable steps cached → `runStreamingAgentLoop` is still called (canary: the loop's bare-body glue re-runs per invocation by design).
5. `llm-iter1` cached (real loop wired in) → `provider.chatStream` never called, no `text_delta` reaches the delivery handle, cached content persists — the no-re-billing / no-duplicate-preamble contract at the wire.
6. `degraded-reply` cached → no synthesis `chat` call, no retract/apology pushes, cached apology persists.
7. `auto-recall` cached → no `memory.recall` round trip, cached memories reach the system prompt.
8. `tool-iter1-0` cached → the durable tool handler body does not run; the cached output flows into the transcript.

The loop-level companions live in `src/agent/loop.test.ts` → "durable LLM iterations (stepRun)": cached iterations don't call the provider or re-emit, the `streamed` ledger rebuilds from cached outcomes, cached durable tools don't re-emit their `tool_result` events, and repair budgets recompute deterministically from cached outcomes.

**Why only side-effectful steps get individual tests.** Tests 1-3 cover the steps where re-execution would cause concrete harm (duplicate DB writes, duplicate LLM round trips). The pure-read steps (`load-conversation`, `last-assistant`, `load-inbound`, `load-history`, `assemble-prompt`) are exercised collectively by test 4 and aren't worth individual coverage: if one of them accidentally moved out of `step.run`, the only consequence on retry would be a wasted DB query, not corruption. The cost-of-bug is too low to justify a test per read.

For **wire-level** crash recovery (real Inngest server, real retries, side-effect counters across actual HTTP re-invocations) we rely on Inngest itself — that path is library-tested upstream and our integration test in `pipeline.integration.test.ts` proves the full end-to-end works against a real dev server. We do not currently simulate a forced crash there; if recovery bugs surface in practice, the right escalation is an integration test that throws on first attempt and asserts the second attempt completes.

## State serialization `[confirmed]`

Inngest stores step return values via JSON, so anything returned from a `step.run` body must round-trip through `JSON.stringify` / `JSON.parse` losslessly. Steps returning user-supplied or model-supplied data: `summarize-prefix` and `degraded-reply` (strings), `auto-recall` (Hindsight memories — plain string/metadata records), `tool-iter<N>-<P>` (the handler's string output), and `llm-iter<N>` (`LlmIterationOutcome`, whose `content: ContentBlock[]` is the interesting payload).

For `ContentBlock[]`, the type contract guarantees JSON safety:

- `ImageBlock.data` is `string` (base64 or URL), never a `Buffer` — `attachments.download()` returns a Buffer but `handle-message` immediately calls `.toString("base64")` before placing the bytes in any block.
- `ToolUseBlock.input` is `unknown` but only ever holds JSON-parsed LLM output.
- `ToolResultBlock.content` is `string`.

If a future change introduces a binary field anywhere in `ContentBlock`, it must be encoded to a string before reaching any `step.run` return path. The type system will not catch this — `unknown` accepts anything — so the rule lives here.

**Size.** `llm-iter<N>` is the only step whose output scales with model verbosity: one iteration's content — including full thinking blocks and their signatures — is bounded by `maxOutputTokens` (roughly a few hundred KB of JSON at a 64k-token cap, typically far less). That sits comfortably under Inngest's per-step output limits, but run state is cumulative across iterations and the executor re-ships memoized state on every invocation, so a long thinking-heavy turn pays O(boundaries × state) transfer to the local server. Acceptable at personal scale; if step-state size ever becomes a problem, note that stripping thinking blocks from the outcome is not an option (they must be replayed to the API on subsequent iterations) — the real levers are a lower thinking budget or a tighter iteration cap.

## Adding a new durable boundary `[confirmed]`

Before wrapping (or deciding not to), **count the boundaries**: state how many step boundaries follow the code in question on a typical run — that's how many times it re-executes when left bare, on success. "It only happens on retry" is the framing error that shipped the N× model-billing bug.

Wrap work in `step.run` when **all** of these are true:

- The RETURN VALUE is small and JSON-serializable (so Inngest can store and replay it). The work itself may stream, emit to a transport, or take minutes — side effects fired from inside the body happen live and are suppressed on replay, which is usually exactly what's wanted (see `llm-iter<N>`).
- Re-executing it would be expensive, billable, wrong, or visible to the user.
- The step's inputs are themselves durable, OR the cached output remains valid even if the inputs drift slightly between attempts. Otherwise the cache freezes against stale inputs.
- If the step is conditional, the condition derives from durable state — a gate on a non-durable read can flip between invocations and diverge the step graph (`summarize-prefix` and `auto-recall` carry a documented residual of this against concurrent profile edits).

Do **not** wrap:

- Pure reads from injected dependencies (cheap, idempotent).
- Code that must genuinely observe every invocation (the `#activeStreams`-deduped `deliveryRouter.prepare`, the loop's control flow) — a step would freeze its first execution's view.
- The loop's *orchestration* (`runStreamingAgentLoop` as a whole) — it is deterministic glue over cached outcomes and must re-walk them each invocation. The expensive work inside it is already wrapped: each iteration in `llm-iter<N>`, each durable tool in `tool-iter<N>-<P>`.
- Pipelines that build large intermediate values (image base64, full message histories) just to return a small final result. Wrap only the expensive sub-step.

When adding a new step, add a corresponding case to `handle-message.replay.test.ts` proving the body does not re-execute on cached replay.
