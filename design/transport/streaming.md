# Streaming `[confirmed]`

Real-time token delivery from the agent loop to channel adapters.

## Problem

Without streaming, Telegram users see nothing for 10-30 seconds while the LLM generates. Industry standard (Claude.ai, ChatGPT, AG-UI protocol) is to stream every turn: text appearing token-by-token, tool use indicators mid-stream, then more text.

## Architecture

```
Agent loop (handle-message)
  → delivery router resolves targets, partitions by adapter type
  → streaming: openStream() → push(StreamEvent) → finish()
  → batch: deliver(content) after persist
  → response/ready emitted (notification only — not a delivery trigger)
```

A single delivery router resolves all targets upfront and handles both paths. The orchestrator calls the router once; it doesn't know about channels, adapters, or delivery mechanisms. The separate per-channel respond Inngest function is eliminated — delivery is inline.

## Stream Events

```typescript
type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string; signature: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError?: boolean }
  | { type: "status"; message: string }
  | { type: "retract"; text: string; toolUseIds: ReadonlyArray<string> }
```

Not every member comes from a provider stream — the union is the
orchestrator→adapter presentation channel. `status` is emitted by the pre-flight
compaction stage, and `retract` by the degraded off-ramp: it names the streamed
output the turn will not persist — the degrade-triggering iteration's text (the
tail of what streamed) and its tool-call ids — so what the user is left reading
is what history holds (see `design/agent-resilience.md` → Degraded reply).
Output from earlier iterations of the turn is persisted, is not named, and
stays; mid-stream attachments cannot be taken back.

`tool_start` carries an `id` because `retract` names tool calls by it. An
adapter that renders a marker for a tool call must be able to find that marker
again from the id alone.

**`thinking_delta` is not rendered, and that is the contract, not an
oversight.** It carries Anthropic extended-thinking output: the loop emits one
event per thinking block, at block end rather than per token, with the full
accumulated text and the block's `signature`. The signature is what lets the
block be replayed back to the provider on a later turn, so the event exists to
keep thinking in the transcript and in the request, not to put it on a screen.
Both current adapters drop it — Telegram has no branch for it, the web client
skips it in `applyStreamEvent`. A new adapter should drop it too unless the
surface is explicitly a debugging view: reasoning text is the model's scratch
work, it is often long enough to blow a message budget on its own, and it is
not part of what the turn persists as the assistant's reply. An adapter that
does choose to show it must render it as visibly distinct from the reply and
must not let it consume the text budget the reply needs.

Finish and abort are signaled via `StreamHandle` methods, not events — they are adapter lifecycle, not broadcast content.

Events flow through the agent loop across multiple LLM turns:

```
LLM call 1:  text_delta, text_delta, ..., tool_start
             (tool executes)
LLM call 2:  tool_result, text_delta, text_delta, ..., tool_start
             (tool executes)
LLM call 3:  tool_result, text_delta, text_delta, ...
             (end_turn → finish)
```

## No Broadcaster

Earlier iterations included a `StreamBroadcaster` (pub/sub interface for external subscribers). This was dropped — every consumer that needs stream events should be an adapter going through the `DeliveryRouter`. If raw observation is needed for debugging later, `DeliveryHandle.push()` is the natural hook point.

If Inngest Realtime becomes available for self-hosted ([PR #2537](https://github.com/inngest/inngest/pull/2537)), it would replace the in-process delivery router, not layer on top of it.

## Streaming Adapter

Adapters that support streaming implement `StreamingAdapter`. Adapters that don't implement `Adapter` — batch delivery only, no change.

```typescript
interface Adapter {
  stop(): Promise<void>;
  deliver(platformAddress: string, content: string): Promise<void>;
}

interface StreamingAdapter {
  stop(): Promise<void>;
  openStream(
    platformAddress: string,
    runId: string,
    opts?: StreamOpts,
  ): Promise<StreamHandle>;
}

interface StreamOpts {
  chunkChars: number;   // rotate to a new message past this source-text size
  allowEdits: boolean;  // false = append-only, no mid-message edits
}

interface StreamHandle {
  push(event: StreamEvent): Promise<Result<void, string>>;
  finish(): Promise<Result<void, string>>;   // resolves once the stream has settled
  abort(error: string): Promise<Result<void, string>>;
}
```

No inheritance between `Adapter` and `StreamingAdapter` — they are separate interfaces for separate delivery paths. The stream router checks which one the adapter implements and uses the right path.

A handle reports delivery failures as values, never as rejections. Once it fails it writes nothing more: every later call errs with the same reason, and the adapter's next `openStream` for the run returns a fresh handle.

### Per-Profile Presentation Knobs `[confirmed]`

`StreamOpts` is derived from the active profile in the orchestrator and forwarded to `openStream` via `RoutingContext.streamOpts`:

- `chunkChars` — soft cap on a single message's source length before the adapter rotates to a fresh message. Default 4000 (just under Telegram's 4096 char cap, leaving HTML-tag headroom). DB CHECK constrains the column to 100..4000. Lower it for a "burst of short messages" UX where the reply lands as several smaller bubbles instead of one growing edit.
- `allowEdits` — when false, the adapter never edits a message mid-stream. It emits whole chunks on boundary / finish, drops in-message tool / status banners (they'd land stale and mid-paragraph at the next chunk boundary), and surfaces progress via the platform-native typing indicator. For Telegram: `sendChatAction("typing")` on first push, refreshed every 3.5s (under the 5s auto-clear), cleared on `finish` / `abort`. The error tail in `abort` emits as a fresh chunk too, since `editMessage` is off the table.

Schema: two columns on `profiles` (`stream_chunk_chars INTEGER NOT NULL DEFAULT 4000`, `stream_edits BOOLEAN NOT NULL DEFAULT true`) plus `chk_profiles_stream_chunk_chars` CHECK. Adapters may ignore knobs that don't apply (a future SSE-style web stream would honor neither).

### Adapter Rendering

Each adapter decides how to render `StreamEvent`s. The interface delivers typed events; the adapter is a renderer.

**Telegram:**
- `text_delta` → accumulate text; if `allowEdits` (default), throttled `editMessage` every ~500ms; rotate to a new message once accumulated source exceeds `chunkChars`
- `tool_start` / `status` → append status text (e.g. "Searching..."). **Append-only mode (`allowEdits=false`) drops these** — the typing heartbeat carries progress instead
- `tool_result` → skip (LLM will summarize); image/document results deliver out-of-band via `sendPhoto` / `sendDocument`
- `retract` → cut the named text — and anything the buffer holds after it, i.e. that iteration's own banners — out of the accumulated buffer, keeping the message id so the next text edits the message the fragment was in. Text from earlier iterations stays buffered and visible. Chunks that already overflowed into their own messages can't be edited back, so a retraction reaching into one clears the editable remainder and leaves the chunk
- First push in append-only mode also kicks `sendChatAction("typing")` on a 3.5s refresh loop, cleared on `finish` / `abort`
- `finish()` → emit any remaining buffer with HTML formatting; in edit mode this is the final `editMessage`, in append-only mode it's a fresh `sendMessage`
- `abort(error)` → append `⚠️ ${error}` and emit (edit in edit mode, fresh send in append-only mode)
- Write failures: see [Telegram stream handle](#telegram-stream-handle-confirmed)

**Web UI (future):**
- All events pushed as SSE, rendered as rich components (tool cards, streaming text)

**CLI / Direct:**
- `text_delta` → `process.stdout.write()`
- `tool_start` → `console.log("[tool] ...")`

## Orchestrator Changes

Each LLM iteration runs inside `step.run("llm-iter<N>")` — streaming does not require leaving the durable boundary. Tokens are pushed to the delivery handle from inside the step body as they arrive; only the iteration's final content blocks are the step's return value. On an Inngest replay the cached outcome is returned without re-emitting, so the user never sees the turn re-streamed. Durable steps handle everything before and after; delivery is unified — the orchestrator calls the delivery router once, which handles both streaming and batch. (The sketch below predates the durable-iteration change and shows the loop invocation shape only; see [../crash-recovery.md](../crash-recovery.md) for the current durability map.)

```typescript
inngest.createFunction({
  id: "handle-message",
  triggers: [{ event: "inbound/ready" }],
  concurrency: conversationTurnConcurrency, // env-scoped, keyed on conversationId
}, async ({ event, step, runId }) => {
  const { conversationId } = event.data;
  // runId from Inngest — stable across retries of the same invocation

  // ──── DURABLE: load context ────
  const { systemPrompt, history, model, service, maxInboundId } =
    await step.run("prepare", async () => {
      // load conversation, inbound messages, build user turn,
      // assemble system prompt, load history
      // ... (existing steps collapsed)
    });

  // ──── NON-DURABLE: resolve targets + stream ────
  const delivery = await deliveryRouter.prepare(conversationId, runId);

  let result: AgentLoopResult;
  try {
    result = await runStreamingAgentLoop({
      provider, model, systemPrompt, history, tools, service,
      onEvent: (event) => delivery.push(event),
    });
    await delivery.finish();
  } catch (err) {
    await delivery.abort(err instanceof Error ? err.message : "Unknown error");
    throw err; // re-throw for Inngest retry
  }

  // ──── DURABLE: persist ────
  const assistantMsg = await step.run("persist", async () => {
    return agentStore.insertMessage({
      conversationId, role: "assistant",
      content: result.text, lastInboundMessageId: maxInboundId,
    });
  });

  // ──── NON-DURABLE: batch delivery ────
  await delivery.deliverBatch(result.text);

  // ──── DURABLE: notify ────
  await step.sendEvent("send-response", responseReady.create({
    conversationId, messageId: assistantMsg.id,
  }));
});
```

**`response/ready` is now a notification, not a delivery trigger.** It signals that the response is persisted — consumed by the Observer (correction extraction), metrics, logging. No per-channel respond functions needed.

**Error handling:** The orchestrator wraps the streaming section in try/catch. On failure, calls `delivery.abort(error)` so adapters can show the error to the user.

```typescript
  // ──── NON-DURABLE: resolve targets + stream ────
  const delivery = await deliveryRouter.prepare(conversationId, runId);

  try {
    const result = await runStreamingAgentLoop({
      provider, model, systemPrompt, history, tools, service,
      onEvent: (event) => pushOrThrow(delivery, event),
    });
    const finished = await delivery.finish();
    if (finished.isErr()) log.warn({ err: finished.error }, "stream delivery failed at finish");
  } catch (err) {
    const aborted = await delivery.abort(err instanceof Error ? err.message : "Unknown error");
    if (aborted.isErr()) log.warn({ err: aborted.error }, "stream delivery failed at abort");
    throw classify(err); // the loop's error decides the retry
  }
```

A delivery failure is handled by where it happens:

| Call | On a failed target | Why |
|-|-|-|
| `push` | `pushOrThrow` throws, failing the step that pushed | The step's retry re-streams the iteration into a fresh handle. |
| `finish` | Logged; the reply persists | Every token already went out live, and replayed iterations re-emit nothing, so a retry delivers nothing more. |
| `abort` | Logged; the loop's error is rethrown with its classification | A delivery failure must not turn a deterministic 4xx retriable, or the reverse. |

**Crash behavior:** If the process crashes mid-stream, the `llm-iter<N>` step never completed, so the retry re-runs that iteration's body and re-streams it from the top; completed iterations replay from cache without re-emitting. The adapter deduplicates the handle via `runId` — see Retry Deduplication below.

## Delivery Router

Unified delivery for both streaming and batch. Lives in the transport layer. The orchestrator calls `prepare()` once — the router resolves all targets, partitions by adapter type, and returns a handle the orchestrator uses for the entire delivery lifecycle.

```typescript
interface DeliveryHandle {
  /** Fan out a stream event to all streaming targets. */
  push(event: StreamEvent): Promise<Result<void, StreamDeliveryError>>;
  /** Signal stream completion — calls finish() on all stream handles. */
  finish(): Promise<Result<void, StreamDeliveryError>>;
  /** Signal stream failure — calls abort() on all stream handles. */
  abort(error: string): Promise<Result<void, StreamDeliveryError>>;
  /** Deliver final content to all batch targets. Called after persist. */
  deliverBatch(content: string): Promise<void>;
}

function createDeliveryRouter(deps: {
  adapters: Map<string, Adapter | StreamingAdapter>;
  transportStore: TransportStore;
}): DeliveryRouter {
  const { adapters, transportStore } = deps;

  return {
    async prepare(conversationId: string, runId: string): Promise<DeliveryHandle> {
      // Resolve all targets — same routing logic for both paths
      const sessions = await resolveRoutingTargets(conversationId, transportStore);

      // Partition by adapter type
      const streamHandles = new Map<string, StreamHandle>();
      const batchTargets: Array<{ platformAddress: string; adapter: Adapter }> = [];

      for (const session of sessions) {
        const adapter = adapters.get(session.channelId);
        if (!adapter) continue;

        if (isStreamingAdapter(adapter)) {
          const handle = await adapter.openStream(session.platformAddress, runId);
          streamHandles.set(session.id, handle);
        } else {
          batchTargets.push({ platformAddress: session.platformAddress, adapter });
        }
      }

      return {
        push: (event) => fanOut(streamHandles, (h) => h.push(event)),
        finish: () => fanOut(streamHandles, (h) => h.finish()),
        abort: (error) => fanOut(streamHandles, (h) => h.abort(error)),
        async deliverBatch(content) {
          for (const { platformAddress, adapter } of batchTargets) {
            await adapter.deliver(platformAddress, content);
          }
        },
      };
    },
  };
}
```

`resolveRoutingTargets()` is the shared routing logic extracted from [response-routing.md](response-routing.md) — find active sessions, apply routing strategy (`source`, `lastInbound`, or `all`), return session list. One function, one query, used by both paths.

`fanOut` calls every handle at once under `Promise.allSettled` and errs with a `StreamDeliveryError` listing each target that failed, whether it returned its failure or rejected. One failing target never keeps the others from an event, their finish, or their `turn-abort`.

## Retry Deduplication

Inngest re-invokes the function at every step boundary (and on retries), and `deliveryRouter.prepare()` re-executes each time — calling `openStream()` again. Without dedup, each re-invocation that pushes anything would open a second message.

**Solution:** `openStream()` receives `runId` (Inngest's run ID, stable across all invocations of the same run). Adapters deduplicate in-memory:

```typescript
// Inside TelegramAdapter
#activeStreams = new Map<string, TelegramStreamHandle>();

async openStream(platformAddress: string, runId: string, opts?: StreamOpts): Promise<StreamHandle> {
  const existing = this.#activeStreams.get(runId);
  if (existing) return existing; // re-invocation — keep writing the same message

  const handle = new TelegramStreamHandle(this.#bot, this.#attachments, chatId, runId, opts);
  this.#activeStreams.set(runId, handle);
  void handle.done.then(() => this.#activeStreams.delete(runId));
  return handle;
}
```

This works because Inngest connect mode runs in a long-lived process — the in-memory map survives across retries. If the process itself crashes, the map is lost but the old Telegram message is also unreachable (we don't know its ID), so creating a new one is correct.

A handle leaves the map once it settles — finished, aborted, or failed. A failed handle leaving is what lets a retry recover: the retry of the step whose push failed opens a fresh handle and streams into a new message.

## LLM Provider: `chatStream()`

```typescript
interface LlmProvider {
  readonly name: string;
  chat(params: ChatParams): Promise<LlmResponse>;
  chatStream(params: ChatParams): AsyncIterable<StreamEvent>;
}
```

Each provider adapter translates native stream events to canonical `StreamEvent`. **The adapter accumulates tool input internally** — raw APIs stream tool input as JSON deltas (`input_json_delta`), but `chatStream()` yields a single `tool_start` with complete parsed input after the content block finishes. This is industry standard — Anthropic SDK, OpenAI SDK, LangChain, and Vercel AI SDK all accumulate tool calls before surfacing them.

| Provider event | StreamEvent | Notes |
|-|-|-|
| Anthropic `content_block_delta` (text) | `text_delta` | Yielded immediately |
| Anthropic `input_json_delta` | (buffered) | Accumulated internally |
| Anthropic `content_block_stop` (tool_use) | `tool_start` | Yielded with complete parsed input |
| OpenAI `response.output_text.delta` | `text_delta` | Yielded immediately |
| OpenAI `function_call_arguments.delta` | (buffered) | Accumulated internally |
| OpenAI `response.function_call_arguments.done` | `tool_start` | Yielded with complete parsed input |

**Contract:** `chatStream()` never yields partial tool input. The agent loop can safely execute tools immediately on `tool_start`.

## Agent Loop Changes

The agent loop gains a streaming variant that accepts an `onEvent` callback:

```typescript
async function runStreamingAgentLoop(params: {
  provider: LlmProvider;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolRegistry;
  service: Service;
  onEvent: (event: StreamEvent) => Promise<void>;
}): Promise<AgentLoopResult> {
  const { provider, model, systemPrompt, tools, service, onEvent } = params;
  let messages = [...params.messages];

  while (true) {
    const toolDefs = tools.definitions();

    for await (const event of provider.chatStream({ model, system: systemPrompt, messages, tools: toolDefs })) {
      await onEvent(event);

      if (event.type === "tool_start") {
        // Execute tool, emit result
        const result = await tools.execute(event.name, event.input, service);
        await onEvent({ type: "tool_result", name: event.name, output: result.output, isError: result.isError });

        // Append tool use + result to messages for next LLM call
        messages = appendToolRoundtrip(messages, event, result);
      }
    }

    // Check if last event was end_turn (no more tool calls)
    if (lastStopReason === "end_turn" || lastStopReason === "max_tokens") {
      break;
    }
  }

  return { text: accumulatedText, messages, usage, model, iterations };
}
```

## Telegram Specifics

### Telegram stream handle `[confirmed]`

Rate limits: Telegram allows ~30 messages/sec globally and about one per second in one chat; edits count. grammY's guidance ([flood limits](https://grammy.dev/advanced/flood), [auto-retry](https://grammy.dev/plugins/auto-retry)) is not to throttle ahead of the limits, and on a 429 to wait `retry_after` seconds and retry. The handle coalesces previews to one per 500ms, which spares Telegram edits the next one would supersede, and otherwise follows that guidance itself rather than through the auto-retry transformer: a retry that waits without bound would hold the turn open, and a preview needs no retry at all.

`TelegramStreamHandle` (`stream-handle.ts`) drives a pure machine (`stream-state.ts`): `transition(state, input, opts)` returns the next state and its effects as data, and the handle carries them out.

```
 idle ─push─► streaming ─finish · abort─► finalizing ─last write lands─► done
  │               │                            │
  │               └──── a write fails ─────────┴──────────────────────► failed
  └─finish─► done
```

- **State.** `streaming` and `finalizing` carry the live message (`messageId?`), the buffer (`segments`), the chunks cut from it at `chunkChars` and not yet written, `lastEditAt`, and the write in flight.
- **Inputs.** `push`, `retract`, `media_sent`, `finish`, `abort`, and each write's result: `api_ok(messageId)` or `api_failed(failure)`, and `throttle_elapsed` once a wait ends.
- **Effects.** `write`, `wait(ms)`, `start_typing`, `stopped`, `settled(Result)`, `log`.
- **One write at a time.** The machine starts a write only when none is in flight, and takes its result back as an input before choosing the next: chunks in order, then the abort's error tail, then a preview once 500ms have passed since the last. `push` resolves once no write is in flight, so on the happy path its writes have landed when it returns.

Each failure has one answer:

| Failure | Preview | Chunk or error tail |
|-|-|-|
| `message is not modified` | Landed | Landed |
| 429 with `retry_after` ≤ 30s | Wait; the first preview after it carries the latest text | Wait, then write it again |
| 429 the fifth time in a row, or `retry_after` > 30s | Fail | Fail |
| `can't parse entities` | — (previews are plain) | Write the source as plain text; fail if that is rejected too |
| Anything else | Fail | Fail |

A failed handle settles `done` with the reason, stops the typing heartbeat, leaves `#activeStreams`, and answers every later call with its failure without writing. The heartbeat is bound to the handle's `AbortSignal`, which aborts once the stream takes no more content, and its interval is unref'd.

## Routing

Routing targets are computable BEFORE the response exists — `conversationId`, source sessions, `lastInbound` session, `receive: "all"` sessions are all known at turn start (see [overview.md](overview.md)). The delivery router resolves all targets once, upfront.

### Full flow

```
1. handle-message starts
2. Load context (durable steps)
3. deliveryRouter.prepare() → resolves all targets, partitions by adapter type,
   opens stream handles for StreamingAdapters
4. Stream LLM response → delivery.push(event) fans out to stream handles
5. delivery.finish() — finalizes all stream handles
6. Persist assistant message (durable step)
7. delivery.deliverBatch(content) — delivers to batch adapters
8. Emit response/ready (notification only — Observer, metrics, logging)
```

### Unified delivery

One router, one resolution, two delivery mechanisms:

| Path | Adapter type | When | Mechanism |
|-|-|-|-|
| Streaming | `StreamingAdapter` | Before persist (real-time) | `openStream()` → `push()` → `finish()` |
| Batch | `Adapter` | After persist | `deliver(content)` |

Both paths are driven by the same `DeliveryHandle` returned by `prepare()`. The orchestrator calls `push()` during streaming, `deliverBatch()` after persist. It doesn't know which sessions are streaming vs batch — the router handles that internally.

### Error case: stream aborts

If the LLM call fails mid-stream, the orchestrator calls `delivery.abort(error)`. All stream handles receive `abort()` — the adapter appends an error indicator to the partial message. Batch targets are never reached (persist didn't happen). No duplicate messages.

### `response/ready` is a notification

With unified delivery, `response/ready` no longer triggers per-channel respond functions. It becomes a pure signal that the response is persisted:

- Observer listens for idle detection (correction extraction, future memory extraction)
- Metrics/logging
- External integrations

The per-channel `createRespond()` Inngest functions are eliminated.

## Dependencies

| Component | Module | Depends on |
|-|-|-|
| `StreamEvent` type | `src/llm/types.ts` | Nothing |
| `StreamingAdapter`, `StreamHandle` | `src/transport/types.ts` | `StreamEvent` |
| `DeliveryRouter`, `DeliveryHandle` | `src/transport/` | `StreamingAdapter`, `Adapter`, routing logic |
| `chatStream()` on `LlmProvider` | `src/llm/provider.ts` | `StreamEvent` |
| Orchestrator changes | `src/agent/handle-message.ts` | `DeliveryRouter` |
