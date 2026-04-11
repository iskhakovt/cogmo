# Crash Recovery `[confirmed]`

How `handle-message` survives worker crashes, what re-executes on resume, and why some side effects intentionally re-run.

## The Inngest model in one paragraph

Inngest does not pause and resume coroutines. It re-invokes the entire function over the wire for each step boundary. The SDK matches each `step.run("id", ...)` against state stored on the Inngest server and, if the ID is already in the state, returns the cached value **without calling the body**. Code outside `step.run` runs on every invocation. "Crash recovery" therefore means: on retry, durable steps replay from the state store; everything else re-executes from the top of the function.

This has two consequences:

1. **Side effects inside `step.run` are exactly-once across retries.** Inserting a row, sending an event via `step.sendEvent`, calling an LLM via `step.run` — all run once, then their results are cached.
2. **Side effects outside `step.run` are at-least-once.** They re-execute on every retry. If a developer accidentally puts a DB write or an API call in the bare function body, it will fire repeatedly.

The bug class to catch is #2. The contract below makes #1 vs #2 explicit for `handle-message`.

## `handle-message` durability map

| Phase | Step ID | Body | Side effect | Replays from cache |
|-|-|-|-|-|
| Load | `load-conversation` | `agentStore.getConversation` | DB read | ✓ |
| Load | `last-assistant` | `agentStore.getLastAssistantMessage` | DB read | ✓ |
| Load | `load-inbound` | `transportStore.getUnbatchedInbound` | DB read | ✓ |
| Persist | `create-user-message` | `agentStore.insertMessage` (user) | **DB write** | ✓ |
| Load | `load-history` | `agentStore.getHistory` | DB read | ✓ |
| Load | `assemble-prompt` | `promptSource.assemble` | DB read + assembly | ✓ |
| Compact | `compact-context` | `compactMessages` (token count + maybe summarize via `provider.chat`) | **LLM call** if summarization triggered | ✓ |
| **Streaming** | *(none — not in a step)* | image resolution, `memory.recall`, `getProfile`, `deliveryRouter.prepare`, `runStreamingAgentLoop`, tool execution, `delivery.finish` | **LLM stream + tool side effects** | ✗ |
| Persist | `persist-assistant-message` | `agentStore.insertMessage` (assistant) | **DB write** | ✓ |
| Deliver | *(none — not in a step)* | `delivery.deliverBatch` | **Network send to batch adapters** | ✗ |
| Notify | `send-response` | `step.sendEvent("response/ready")` | Inngest event | ✓ |
| Resume | `flush` (conditional) | `step.sendEvent("inbound/ready")` | Inngest event | ✓ |

The two non-durable regions are the streaming section and the post-persist batch delivery. Both are intentional:

- **Streaming.** You cannot stream events out of `step.run` — a step returns a single JSON-serializable value at the end. To deliver tokens to Telegram as they arrive, the LLM call has to happen in the bare function body. See [transport/streaming.md](transport/streaming.md) → "Orchestrator Changes".
- **Batch delivery.** Lives outside the persist step so that adapters receive the *final* assistant text after it has been written to the DB. Idempotency is the adapter's responsibility (see "Streaming dedup" below).

## What this means in practice

### When the streaming section crashes

If `runStreamingAgentLoop` throws (network blip, API error, OOM):

1. Inngest catches the throw, marks the function as failed for this attempt, and re-invokes it (up to `retries: 2`).
2. On the new invocation, every durable step above runs from cache:
   - `create-user-message` returns its prior `void` result. **No double user-message insert.**
   - `compact-context` returns its prior compacted history. **No double summarization LLM call.**
3. The streaming section re-runs from scratch. This means:
   - `memory.recall` runs again (idempotent — pure read).
   - `attachments.download` re-fetches images (idempotent — pure read).
   - `runStreamingAgentLoop` makes new LLM calls and re-executes any tools the LLM picks.
4. If it succeeds this time, `persist-assistant-message` runs, the response is delivered, and the function resolves.

The user observes a message that took longer than usual (one extra round of tool calls and LLM tokens), but never sees a corrupted conversation, never sees a duplicate user message, and never gets billed twice for summarization.

### Tool side effects that re-execute

The streaming section is where tools run, so tool side effects are at-least-once on retry. By tool:

| Tool | Re-execution behavior |
|-|-|
| `memory_recall`, `read_file`, `list_files`, `current_time` | Pure reads — free to repeat. |
| `web_search`, `web_answer`, `fetch_url` | Wastes external API quota. Otherwise benign — results inform the next LLM call only. |
| `memory_retain` | Writes the same fact twice. Hindsight's `reflect()` job dedupes downstream. |
| `core_memory_update`, `write_file` | Idempotent overwrites with the same content. No corruption. |

Net cost of a single retry: one extra LLM round-trip plus, in the worst case, a few duplicated external API calls. Acceptable for v0.

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

## Test coverage

`src/agent/handle-message.replay.test.ts` exercises the durability contract via `@inngest/test`'s `steps:` mechanism, which is Inngest's memoization model exposed for tests. Each test provides a step in `steps:` to simulate "this step already ran in a prior attempt" and asserts the step body's side effects do not repeat.

The four cases:

1. `create-user-message` cached → no user-role `insertMessage` call.
2. `persist-assistant-message` cached → no assistant-role `insertMessage` call.
3. `compact-context` cached → no `provider.chat` call (the summarization LLM call is inside the step body).
4. All durable steps cached → `runStreamingAgentLoop` is still called (canary for the non-durable contract).

The fourth test is the regression guard for the bug class. If a developer ever wraps the agent loop in `step.run` to "make it durable", the test still passes — but the streaming behavior breaks at runtime, and the inverse mistake (moving a side effect *out* of a step) would be caught by tests 1-3 because the side effect would suddenly be observable.

For **wire-level** crash recovery (real Inngest server, real retries, side-effect counters across actual HTTP re-invocations) we rely on Inngest itself — that path is library-tested upstream and our integration test in `pipeline.integration.test.ts` proves the full end-to-end works against a real dev server. We do not currently simulate a forced crash there; if recovery bugs surface in practice, the right escalation is an integration test that throws on first attempt and asserts the second attempt completes.

## State serialization

Inngest stores step return values via JSON, so anything returned from a `step.run` body must round-trip through `JSON.stringify` / `JSON.parse` losslessly. The `compact-context` step returns `Message[]`, where every value is structurally JSON-safe by the type contract:

- `ImageBlock.data` is `string` (base64 or URL), never a `Buffer` — `attachments.download()` returns a Buffer but `handle-message` immediately calls `.toString("base64")` before placing the bytes in any block.
- `ToolUseBlock.input` is `unknown` but only ever holds JSON-parsed LLM output.
- `ToolResultBlock.content` is `string`.

If a future change introduces a binary field anywhere in `ContentBlock`, it must be encoded to a string before reaching any `step.run` return path. The type system will not catch this — `unknown` accepts anything — so the rule lives here.

## Adding a new durable boundary

Wrap a side effect in `step.run` when **all** of these are true:

- The work is a single observable side effect (DB write, LLM call, external API call) — not a streaming pipeline.
- The result is JSON-serializable (so Inngest can store it and replay it).
- Re-executing it would be expensive, wrong, or visible to the user.

Do **not** wrap:

- Pure reads from injected dependencies (cheap, idempotent).
- Code that captures references to the streaming `delivery` handle and expects to push events on every invocation.
- Anything inside the agent loop body — the loop and its tools must stay in the non-durable section so streaming works.

When adding a new step, add a corresponding case to `handle-message.replay.test.ts` proving the body does not re-execute on cached replay.
