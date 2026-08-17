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
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError?: boolean }
  | { type: "status"; message: string }
  | { type: "retract" }
```

Not every member comes from a provider stream — the union is the
orchestrator→adapter presentation channel. `status` is emitted by the pre-flight
compaction stage, and `retract` by the degraded off-ramp: it tells adapters to
discard the assistant text streamed so far this turn so the degraded reply is
the whole of what the user reads (see `design/agent-resilience.md` → Degraded
reply). It covers text only; mid-stream attachments and tool records belong to
iterations that completed and stand.

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
  push(event: StreamEvent): Promise<void>;
  finish(): Promise<void>;
  abort(error: string): Promise<void>;
}
```

No inheritance between `Adapter` and `StreamingAdapter` — they are separate interfaces for separate delivery paths. The stream router checks which one the adapter implements and uses the right path.

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
- `retract` → clear the accumulated buffer, keep the message id so the next text edits the message the fragment was in. Chunks that already overflowed into their own messages can't be edited back and stay
- First push in append-only mode also kicks `sendChatAction("typing")` on a 3.5s refresh loop, cleared on `finish` / `abort`
- `finish()` → emit any remaining buffer with HTML formatting; in edit mode this is the final `editMessage`, in append-only mode it's a fresh `sendMessage`
- `abort(error)` → append `⚠️ ${error}` and emit (edit in edit mode, fresh send in append-only mode)

**Web UI (future):**
- All events pushed as SSE, rendered as rich components (tool cards, streaming text)

**CLI / Direct:**
- `text_delta` → `process.stdout.write()`
- `tool_start` → `console.log("[tool] ...")`

## Orchestrator Changes

The LLM call moves outside `step.run()` to enable streaming. Durable steps handle everything before and after. Delivery is unified — the orchestrator calls the delivery router once, which handles both streaming and batch.

```typescript
inngest.createFunction({
  id: "handle-message",
  triggers: [{ event: "inbound/ready" }],
  concurrency: { limit: 1, key: "event.data.conversationId" },
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
      onEvent: (event) => delivery.push(event),
    });
    await delivery.finish();
  } catch (err) {
    await delivery.abort(err instanceof Error ? err.message : "Unknown error");
    throw err; // re-throw for Inngest retry
  }
```

**Crash behavior:** If the function crashes during streaming, Inngest retries. Durable steps (prepare) replay instantly from cache. The non-durable section (prepare + stream) re-executes. The adapter deduplicates via `runId` — see Retry Deduplication below.

## Delivery Router

Unified delivery for both streaming and batch. Lives in the transport layer. The orchestrator calls `prepare()` once — the router resolves all targets, partitions by adapter type, and returns a handle the orchestrator uses for the entire delivery lifecycle.

```typescript
interface DeliveryHandle {
  /** Fan out a stream event to all streaming targets. */
  push(event: StreamEvent): Promise<void>;
  /** Signal stream completion — calls finish() on all stream handles. */
  finish(): Promise<void>;
  /** Signal stream failure — calls abort() on all stream handles. */
  abort(error: string): Promise<void>;
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
        async push(event) {
          for (const handle of streamHandles.values()) {
            await handle.push(event);
          }
        },
        async finish() {
          for (const handle of streamHandles.values()) {
            await handle.finish();
          }
        },
        async abort(error) {
          for (const handle of streamHandles.values()) {
            await handle.abort(error);
          }
        },
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

## Retry Deduplication

On Inngest retry, the durable steps replay from cache but `deliveryRouter.prepare()` re-executes — calling `openStream()` again. Without dedup, the adapter sends a second initial message.

**Solution:** `openStream()` receives `runId` (Inngest's run ID, stable across retries). Adapters deduplicate in-memory:

```typescript
// Inside TelegramAdapter
#activeStreams = new Map<string, TelegramStreamHandle>();

async openStream(platformAddress: string, runId: string): Promise<StreamHandle> {
  const existing = this.#activeStreams.get(runId);
  if (existing) return existing; // retry — reuse existing Telegram message

  const msg = await this.#bot.api.sendMessage(chatId, "...");
  const handle = new TelegramStreamHandle(this.#bot, chatId, msg.message_id);
  this.#activeStreams.set(runId, handle);
  return handle;
}
```

This works because Inngest connect mode runs in a long-lived process — the in-memory map survives across retries. If the process itself crashes, the map is lost but the old Telegram message is also unreachable (we don't know its ID), so creating a new one is correct.

Clean up: remove entries from `#activeStreams` after `finish()` or `abort()` to prevent unbounded growth.

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

Rate limits: Telegram allows ~30 edits/sec globally, ~2-3/sec per message recommended. The Telegram `StreamHandle` implementation throttles edits internally.

```typescript
// TelegramStreamHandle (sketch)
class TelegramStreamHandle implements StreamHandle {
  #bot: Bot;
  #chatId: string;
  #messageId: number | null = null;
  #accumulated = "";
  #lastEdit = 0;
  #editInterval = 500; // ms

  async push(event: StreamEvent): Promise<void> {
    if (event.type === "text_delta") {
      this.#accumulated += event.text;
    } else if (event.type === "tool_start") {
      this.#accumulated += `\n🔍 ${event.name}...\n`;
    }
    // tool_result: skip — LLM will summarize

    await this.#throttledEdit();
  }

  async finish(): Promise<void> {
    // Final edit with full content + formatting
    await this.#edit(this.#accumulated);
  }

  async abort(error: string): Promise<void> {
    await this.#edit(this.#accumulated + `\n\n⚠️ ${error}`);
  }

  async #throttledEdit(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastEdit < this.#editInterval) return;
    await this.#edit(this.#accumulated);
  }

  async #edit(text: string): Promise<void> {
    if (!this.#messageId) {
      const msg = await this.#bot.api.sendMessage(this.#chatId, text);
      this.#messageId = msg.message_id;
    } else {
      await this.#bot.api.editMessageText(this.#chatId, this.#messageId, text);
    }
    this.#lastEdit = Date.now();
  }
}
```

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
