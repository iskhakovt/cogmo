# Debounce & Message Batching `[confirmed]`

## Problem

User sends rapid messages: "hey" / "can you check" / "my calendar". Without debounce, each triggers a separate agent response — first two are useless, third is the only one that matters. Bad UX, wasted cost.

## Design

Two paths picked at construction time from `DebounceConfig`. Both end at the same orchestrator (`handle-message`) via `inbound/ready`.

### Path 1 — native fast path (default) `[confirmed]`

Used when `idleTimeoutMs >= 1000` (Inngest's minimum debounce period) and `maxWaitMs` is either `0` or `>= 1000`. The router carries Inngest's native `debounce` config keyed on `conversationId`:

```typescript
{
  debounce: {
    // Floor to whole seconds (Inngest's period/timeout types accept the
    // `${number}s` template only). Floor under-shoots the configured idle
    // by up to 999 ms, which is safer than over-shooting.
    period: `${Math.max(1, Math.floor(idleTimeoutMs / 1000))}s`,
    // `timeout` is omitted entirely when maxWaitMs === 0 — Inngest treats
    // a missing timeout as "no ceiling," matching the legacy "idle-only" mode.
    ...(maxWaitMs > 0 && { timeout: `${Math.max(1, Math.floor(maxWaitMs / 1000))}s` }),
    key: "event.data.conversationId",
  }
}
```

Inngest coalesces same-key events at the queue layer. Two `inbound/arrived` events arriving milliseconds apart for the same conversation produce **one** router run, with `event` set to the last event in the burst. The router emits a single `inbound/ready` and returns. No idle/maxwait timer functions exist in this path.

This is the cancel-race-free path. It replaces the cancel-based state machine for the configs we actually run in production.

### Path 2 — legacy state machine (fallback) `[confirmed]`

Used when the config doesn't fit native debounce: `idleTimeoutMs == 0` (no-debounce mode), sub-second debounce, or maxwait-only. Up to four Inngest functions per inbound message (router, idle timer, maxwait timer, orchestrator), entry guards on the orchestrator, and resume logic at the end of each orchestrator run. The cancel-listener race documented below applies to this path; the orchestrator's stale-trigger guard mops up duplicates after the fact.

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

### Race condition: cancelOn vs sendEvent (legacy path only)

Inngest registers cancel listeners *after* the function starts, and cancels between steps rather than during a step. Two windows where this matters:

```
# Window 1 — cancel listener not yet registered
event #1 inbound/arrived → debounce-idle starts running
event #2 inbound/arrived (~tens of ms later) → cancel signal fires
  but #1's listener isn't registered yet → both runs proceed to completion

# Window 2 — sleep just completed, sendEvent in flight
debounce sleep completes → sendEvent starts executing → inbound/arrived arrives
→ sendEvent completes (event emitted) → function cancelled → new debounce starts
→ TWO inbound/ready events exist
```

**Issue #121** documented Window 1: Telegram's automatic long-message split delivered two messages 7 ms apart, both `debounce-idle` runs survived the cancel race, both `debounce-maxwait` runs always survive (no cancel by design), and `handle-message` ran 4× for one user turn.

**Mitigation in the legacy path:** The staleness guard (`triggerInboundId <= cursor`) catches leaked events. First valid event processes everything; leaked events get caught at the orchestrator's entry guard and skipped. Wasted Inngest runs but no duplicate replies — assuming the first run succeeds and writes an assistant message that advances the cursor. If the first run fails before persisting, the guard never engages and every duplicate retries until something else stops them.

**Eliminated in the native path:** Inngest's native debounce dedupes at enqueue time using the debounce key, not via post-start cancel listeners. No race window exists.

### Observability

Both paths feed the `debounceWaitMs` histogram, but with different semantics:

- **Legacy path:** `kind: "idle" | "maxwait"` — exact sleep duration recorded by the timer function.
- **Native path:** `kind: "native"` — approximated as `Date.now() - event.ts` for the trigger event (last-event-to-handler-fire). Inngest doesn't expose internal debounce timing, so this is the best proxy. For idle-dominated bursts it's close to the actual debounce period; for maxwait-dominated bursts it under-reports because the trigger event is the most recent one, not the first.

### Are the guards now obsolete?

Two pieces — different answers:

- **`cancelOn` on the legacy timers** is obsolete in the native path (no timer functions exist to cancel) and still load-bearing in the legacy path (sub-second / edge configs).
- **Staleness guard in `handle-message`** (`triggerInboundId <= lastAssistant.lastInboundMessageId` → skip) is **not obsolete**, even though it's unreachable under normal operation in the native path. Reasons to keep it:
  - Legacy path still exercises it.
  - Inngest queues are durable with no default TTL — after a long outage, queued `inbound/ready` events drain on recovery and may now be stale relative to whatever else advanced the cursor.
  - One already-loaded DB column comparison; the brittleness of removing a backstop costs more than keeping six lines.
  - Coupling: removing the guard belongs with the future native-only migration, not with the introduction of the native fast path.

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

## Future migration: collapse to native-only `[proposed]`

The legacy state machine exists only to cover three modes that native Inngest debounce can't express:

- `idleTimeoutMs == 0` — no-debounce passthrough (mostly used in tests)
- sub-second debounce (Inngest's minimum is 1s; not used in any realistic config)
- maxwait-only (`idleTimeoutMs == 0, maxWaitMs > 0`) — pure throttle (not used)

If none of these turn out to be load-bearing — i.e. tests adopt a small minimum like 1s and no production deployment ever wants sub-second or maxwait-only — collapse to **native-only**: delete `debounce-idle`, `debounce-maxwait`, the `debounce/idle` / `debounce/maxwait` / `debounce/cancel` events, and the legacy branch in `createDebounceFunctions`. The router becomes a 15-line function with native debounce config and a single `step.sendEvent`.

Trigger to revisit: when changing the debounce config schema, when the legacy code path next breaks, or after ~6 months of no production use of the edge modes. The `debounce/cancel` event is already dead code and can be deleted independently of this migration when nothing else changes in this area.
