# Debounce & Message Batching `[confirmed]`

## Problem

User sends rapid messages: "hey" / "can you check" / "my calendar". Without debounce, each triggers a separate agent response — first two are useless, third is the only one that matters. Bad UX, wasted cost.

## Design

Up to four Inngest functions per inbound message (router, idle timer, maxwait timer, orchestrator), entry guards on the orchestrator, and resume logic at the end of each orchestrator run.

### Events

| Event | Payload | Emitted by | Consumed by |
|-|-|-|-|
| `inbound/arrived` | conversationId, inboundMessageId | Adapter | debounce-router |
| `debounce/idle` | conversationId, inboundMessageId, timeoutMs | debounce-router | debounce-idle (cancelOn: debounce/idle, debounce/cancel) |
| `debounce/maxwait` | conversationId, inboundMessageId, timeoutMs | debounce-router | debounce-maxwait (cancelOn: debounce/cancel) |
| `inbound/ready` | conversationId, triggerInboundId (nullable) | debounce functions, debounce-router (no debounce), orchestrator (flush) | handle-message |
| `debounce/cancel` | conversationId | orchestrator (optional, not emitted currently) | debounce-idle, debounce-maxwait (cancelOn) |
| `response/ready` | conversationId, messageId | orchestrator | respond function |

### Debounce Config

Org-level setting (per-user overrides possible later). Hardcoded for v0 — move to a config table when per-user or per-profile overrides are needed.

```typescript
interface DebounceConfig {
  idleTimeoutMs?: number;   // resets on each message — "user stopped typing"
  maxWaitMs?: number;       // hard deadline — "don't wait forever"
  resumePolicy: "debounce" | "flush" | "await_input";
}
```

| idleTimeout | maxWait | Behavior |
|---|---|---|
| set | set | Fire on whichever comes first |
| set | unset | Pure debounce, could wait indefinitely |
| unset | set | Pure throttle, fire every N ms |
| unset | unset | No debounce — router emits `inbound/ready` directly |

### Functions

#### debounce-router

Listens to `inbound/arrived`. Reads debounce config and emits the appropriate events. The adapter stays dumb — just says "message arrived." The router decides what to do.

```typescript
inngest.createFunction({
  id: "debounce-router",
  triggers: [{ event: "inbound/arrived" }],
}, async ({ event, step }) => {
  const config = await step.run("config", () => getDebounceConfig());
  const { conversationId, inboundMessageId } = event.data;
  const events = [];

  if (config.idleTimeoutMs)
    events.push({ name: "debounce/idle", data: { conversationId, inboundMessageId, timeoutMs: config.idleTimeoutMs } });
  if (config.maxWaitMs)
    events.push({ name: "debounce/maxwait", data: { conversationId, inboundMessageId, timeoutMs: config.maxWaitMs } });
  if (events.length === 0)
    events.push({ name: "inbound/ready", data: { conversationId, triggerInboundId: inboundMessageId } });

  await step.sendEvent("route", events);
  return { emitted: events.map(e => e.name) };
});
```

#### debounce-idle & debounce-maxwait

Both share the same handler — sleep for `timeoutMs`, then emit `inbound/ready`. The only difference is the `cancelOn` config: idle resets on each new message, maxwait doesn't.

```typescript
function buildDebounceTimer(id: string, trigger: string, cancelOn: CancelOn[]) {
  return inngest.createFunction({
    id,
    triggers: [{ event: trigger }],
    cancelOn,
  }, async ({ event, step }) => {
    await step.sleep("wait", `${event.data.timeoutMs}ms`);
    await step.sendEvent("fire", {
      name: "inbound/ready",
      data: {
        conversationId: event.data.conversationId,
        triggerInboundId: event.data.inboundMessageId,
      },
    });
  });
}

// Idle: cancelled by next message (resets timer). Only last survives.
const debounceIdle = buildDebounceTimer("debounce-idle", "debounce/idle", [
  { event: "debounce/idle", match: "data.conversationId" },
  { event: "debounce/cancel", match: "data.conversationId" },
]);

// MaxWait: lives unconditionally. Every message gets its own timer.
// Most get rejected as obsolete by the orchestrator's staleness guard.
const debounceMaxwait = buildDebounceTimer("debounce-maxwait", "debounce/maxwait", [
  { event: "debounce/cancel", match: "data.conversationId" },
]);
```

#### handle-message (orchestrator)

**Critical:** This single function handles the ENTIRE message processing pipeline end-to-end: load unbatched inbound messages, batch into a turn, run the agent, persist the response, emit delivery events, and apply resume policy. All within `concurrency: { limit: 1, key: conversationId }` — guaranteeing exactly one message batch is processed by the agent at a time per conversation. No parallel processing, no race conditions on conversation state.

```typescript
inngest.createFunction({
  id: "handle-message",
  triggers: [{ event: "inbound/ready" }],
  concurrency: { limit: 1, key: "event.data.conversationId" },
}, async ({ event, step }) => {
  const { conversationId, triggerInboundId } = event.data;

  // ──── ENTRY GUARDS ────
  // Load last message and last assistant message. Both needed:
  // - lastMsg: detect dangling user turn (error recovery)
  // - lastResponse: cursor chain (staleness, await_input, inbound loading)
  const lastMsg = await step.run("last-msg", () => getLastMessage(conversationId));
  const lastResponse = await step.run("last-response", () => getLastAssistantMessage(conversationId));
  const config = await step.run("config", () => getDebounceConfig());

  // Invariant: last message should be an assistant response (or null for first message).
  // A dangling user turn means the previous run failed mid-processing.
  // Log error and resume — inbound loading uses lastResponse's cursor,
  // which re-includes the dangling turn's inbound messages.
  if (lastMsg?.role === "user") {
    logger.error({ conversationId, messageId: lastMsg.id }, "resuming unreplied user turn");
  }

  // Guard 1 — Staleness: the trigger inbound message was already batched
  // into a previous turn. Nothing to do. (null trigger = flush, skip this check.)
  if (triggerInboundId !== null && triggerInboundId <= lastResponse?.lastInboundMessageId) {
    return { status: "skipped", reason: "stale" };
  }

  // Guard 2 — Await_input: the trigger inbound was created before the last
  // assistant response. This means it was buffered while the agent was busy — skip.
  // UUIDv7 IDs are monotonically time-ordered across tables — comparing
  // inbound_messages.id with messages.id is safe, no clock skew.
  if (config.resumePolicy === "await_input"
      && triggerInboundId < lastResponse?.id) {
    return { status: "skipped", reason: "await_input" };
  }

  // ──── PROCESSING ────
  // ... load unbatched inbound messages
  //     WHERE id > lastResponse.lastInboundMessageId (null = no lower bound, load all)
  // ... create user message turn (set lastInboundMessageId = max inbound id)
  // ... load conversation history
  // ... assemble system prompt
  // ... run agent loop
  // ... persist assistant response (set lastInboundMessageId = same)
  // ... emit response/ready { conversationId, messageId }

  // ──── RESUME POLICY ────
  // Applied after every response. Downstream is idempotent — safe to always run.
  switch (config.resumePolicy) {
    case "debounce":
      // Do nothing. Debounce functions emitted inbound/ready events that are
      // queued behind the concurrency lock. They'll fire when this run ends.
      // If no debounce events are queued, the next inbound/arrived will
      // start a new debounce cycle.
      break;
    case "flush":
      // Process any remaining unbatched messages immediately (no debounce wait).
      // null triggerInboundId skips the staleness guard.
      await step.sendEvent("flush", {
        name: "inbound/ready",
        data: { conversationId, triggerInboundId: null },
      });
      break;
    case "await_input":
      // Nothing needed — guard 2 catches all queued/future inbound/ready events.
      // Optional: emit debounce/cancel to kill sleeping debounce functions early,
      // reducing wasted orchestrator invocations. Not required for correctness.
      break;
  }

  const userMsg = ...;      // user message created from batched inbound messages (PROCESSING section)
  const assistantMsg = ...;  // assistant response from agent loop (PROCESSING section)

  return {
    status: "processed",
    userMessageId: userMsg.id,
    responseMessageId: assistantMsg.id,
    recovered: lastMsg?.role === "user",
  };
});
```

### Adapter: Event Emission

The adapter is dumb — always emits `inbound/arrived`. The debounce-router reads config and decides what to do.

```typescript
// Adapter — after persisting inbound message:
await inngest.send({
  name: "inbound/arrived",
  data: { conversationId, inboundMessageId: inboundMessage.id },
});
```

## Flow Examples

### Rapid messages, idle fires first

```
t=0  msg1 → inbound/arrived → router → debounce/idle + debounce/maxwait
     → idle-A(2s), maxwait-A(30s)
t=1  msg2 → inbound/arrived → router → debounce/idle + debounce/maxwait
     → idle-A KILLED, idle-B(2s), maxwait-B(30s)
t=2  msg3 → inbound/arrived → router → debounce/idle + debounce/maxwait
     → idle-B KILLED, idle-C(2s), maxwait-C(30s)
t=4  idle-C fires → inbound/ready(trigger=msg3)
     → orchestrator: msg3 > cursor → process msg1+2+3
t=30 maxwait-A fires → inbound/ready(trigger=msg1) → msg1 ≤ cursor → DROP
t=31 maxwait-B fires → inbound/ready(trigger=msg2) → DROP
t=32 maxwait-C fires → inbound/ready(trigger=msg3) → DROP
```

### User keeps typing past maxWait

```
t=0   msg1 → inbound/arrived → router → idle-A(30s), maxwait-A(10s)
t=5   msg2 → inbound/arrived → router → idle-A KILLED, idle-B(30s), maxwait-B(10s)
t=10  maxwait-A fires → inbound/ready(trigger=msg1)
      → orchestrator: msg1 > cursor → process msg1+msg2
t=15  maxwait-B fires → inbound/ready(trigger=msg2) → msg2 ≤ cursor → DROP
t=35  idle-B fires → inbound/ready(trigger=msg2) → DROP
```

### Messages during processing (debounce resume)

```
t=0   msg1 → inbound/arrived → router → idle + maxwait → fires at t=2
t=2   inbound/ready(msg1) → orchestrator starts
t=5   msg2 → inbound/arrived → router → idle-D(2s), maxwait-D(30s)
t=7   idle-D fires → inbound/ready(msg2) → QUEUED (concurrency lock)
t=30  orchestrator finishes → resume=debounce → do nothing
      → lock releases → queued inbound/ready(msg2) fires
      → msg2 > cursor → process msg2
```

### Messages during processing (flush resume)

```
t=0   msg1 → inbound/arrived → router → idle + maxwait → fires at t=2
t=2   orchestrator starts
t=5   msg2 → inbound/arrived → router → idle + maxwait
t=7   idle fires → inbound/ready(msg2) → QUEUED
t=30  orchestrator finishes → resume=flush
      → emit inbound/ready(trigger=null)
      → QUEUED (behind msg2's event)
      → msg2's event fires → processes msg2
      → flush event fires → no leftover → DROP
```

### Messages during processing (await_input resume)

```
t=0   msg1 → inbound/arrived → router → idle + maxwait → fires at t=2
t=2   orchestrator starts (creates user msg + assistant response)
t=5   msg2 → inbound/arrived → router → idle + maxwait
t=7   idle fires → inbound/ready(msg2) → QUEUED (concurrency lock)
t=30  orchestrator finishes → resume=await_input → do nothing
      → lock releases → queued inbound/ready(msg2) fires
      → guard 2: msg2.id < lastResponse.id → SKIP
t=35  maxwait fires → inbound/ready(msg2) → guard 2 → SKIP

t=60  msg3 → inbound/arrived → router → idle + maxwait → fires
      → inbound/ready(msg3)
      → guard 2: msg3.id > lastResponse.id → PROCESS msg2 + msg3
```

Guard 2 catches all buffered events — both queued (from concurrency lock) and late (from maxwait timers). `cancelOn` only cancels running/sleeping functions, NOT queued invocations (Inngest docs). Guard 2 handles both: `triggerInboundId < lastResponse.id` means the inbound was created before the response. When msg3 arrives (after the response), its ID is greater → guard passes → processes all unbatched (including msg2).

### Race condition: cancelOn vs sendEvent

Inngest cancels functions between steps, not during a step. Small race window:

```
debounce sleep completes → sendEvent starts executing → inbound/arrived arrives
→ sendEvent completes (event emitted) → function cancelled → new debounce starts
→ TWO inbound/ready events exist
```

**Not a problem:** The staleness guard (`triggerInboundId <= cursor`) catches the leaked event. First valid event processes everything, leaked event drops.

## Inngest Concurrency Queue

When `inbound/ready` fires while the orchestrator is busy (concurrency limit 1 per conversation), the function invocation is **queued by Inngest**, not dropped:

- Queue is persistent, FIFO ordered
- Queued invocations fire automatically when the slot opens
- No TTL by default (configurable via `timeouts.start`)
- This is what makes `resumePolicy: "debounce"` work without explicit resume logic

## Dangling User Turn Recovery

When the orchestrator finds `lastMsg.role === "user"` (previous run failed mid-processing), it logs an error and falls through to processing. The dangling user turn's `lastInboundMessageId` cursor is past its inbound messages — using it as the lower bound would skip them.

**Resolution:** Always use the last **assistant** message's `lastInboundMessageId` as the lower bound for loading unbatched inbound messages. In the recovery case, this re-includes the dangling turn's inbound messages plus any new ones. In the normal case (lastMsg is assistant), it's the same as using lastMsg directly. See [response-routing.md](response-routing.md) — source routing uses the same assistant-cursor chain for the same reason.

## response/ready

The orchestrator emits `response/ready { conversationId, messageId }` after persisting the assistant response. This event is consumed by the respond function. See [response-routing.md](response-routing.md) for delivery routing details.

## What Drives the Two-Table Design

`inbound_messages` exists because of debounce. Without debounce, every inbound message IS a conversation turn — one table suffices. With debounce, raw messages need a staging area (inbound_messages) before they're batched into turns (messages).

## Schema

```sql
inbound_messages (
  id                UUID v7 PK,
  channel_session_id UUID FK → channel_sessions NOT NULL,
  conversation_id   UUID FK → conversations NOT NULL,  -- denormalized for query performance
  content           JSONB NOT NULL,                     -- structured content (text, images, files, voice)
  platform_ts       TIMESTAMPTZ NOT NULL,               -- when the user sent it (from platform API)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()   -- when we persisted it
);
```

`conversation_id` is denormalized from `channel_sessions` — set once at persist time, never mutated. Avoids a join when loading unbatched messages (`WHERE conversation_id = ? AND id > cursor`).

User is derived from `conversation.userId`, not stored on the inbound message.
