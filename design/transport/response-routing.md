# Response Routing `[proposed]`

How agent responses reach the right platform chats.

> **Note:** The per-channel respond function pattern described here is superseded by the unified `DeliveryRouter` in [streaming.md](streaming.md). The `DeliveryRouter` resolves targets once and handles both streaming and batch delivery inline in the orchestrator. `response/ready` becomes a notification event (Observer, metrics), not a delivery trigger. The routing strategies and source routing logic below remain valid — they're extracted into `resolveRoutingTargets()` used by the `DeliveryRouter`.

## Flow (legacy — see streaming.md for unified flow)

```
response/ready { conversationId, messageId }
  → router (resolve targets, dedup)
  → outbound/deliver per session
  → per-channel adapter delivers
```

The orchestrator emits `response/ready` after persisting the assistant message. A single channel-agnostic router resolves target sessions and emits `outbound/deliver` events. Per-channel adapters listen for their own deliveries.

## Strategies

Which channel session(s) receive the response. All strategies filter to active sessions only (status = 'active', not expired).

```typescript
type RoutingStrategy = "all" | { source?: boolean; lastInbound?: boolean };
```

| Flag | Behavior | Query |
|-|-|-|
| `source` | Session(s) that sent input for this turn | See Source Routing below |
| `lastInbound` | Session that sent the most recent inbound message | `inbound_messages WHERE conversationId ORDER BY id DESC LIMIT 1` → channelSessionId (if session still active) |
| `"all"` | All sessions linked to the conversation | `channel_sessions WHERE conversationId` (filtered) |

Flags compose — `{ source: true, lastInbound: true }` delivers to the union (deduped). `"all"` is an override that ignores flags and broadcasts everywhere.

Default to `{ source: true }`. Hardcoded for v0 — move to a config table when per-org or per-user selection is needed.

**Non-private conversations (`isPrivate: false`) always use `source` routing regardless of config.** Group responses must stay in the group thread that triggered them — routing to `lastInbound` or `all` would leak group context into private chats. Non-private conversations cannot be aliased, resumed, or viewed in the Web UI — they are scoped to their platform thread.

### Web UI

Web UI is a normal channel — creates sessions, sends inbound messages through the pipeline, participates in routing like Telegram or Slack. No special routing flags.

When a user opens a conversation in the Web UI, the adapter creates a `receive: "all"` session (see [sessions.md](sessions.md)). This is how the UI gets live updates — the session has no inbound messages to trigger `source` or `lastInbound` routing, yet it receives all responses for the conversation. This only applies to private conversations (`isPrivate: true`). Non-private conversations are not surfaced in the Web UI.

What the UI displays (unread badges, notifications, filtering by channel) is a client-side concern, not routing.


## Source Routing

Find which inbound messages this response covers, then trace back to their channel sessions.

The range is bounded by consecutive **assistant** messages' `lastInboundMessageId` cursors — not user messages, because a dangling user turn (error recovery) would break the chain.

```sql
-- 1. Find the previous assistant message's cursor (lower bound, NULL for first response)
SELECT last_inbound_message_id FROM messages
WHERE conversation_id = ?
  AND role = 'assistant'
  AND id < ?  -- current assistant message id
ORDER BY id DESC LIMIT 1;

-- 2. Find source channel sessions in the range
-- DISTINCT here is for illustration only — in practice, each strategy
-- collects session IDs independently and dedup happens at the final stage
-- programmatically (e.g. source + lastInbound + web UI → collect all → dedup)
SELECT DISTINCT im.channel_session_id FROM inbound_messages im
JOIN channel_sessions cs ON cs.id = im.channel_session_id
WHERE im.conversation_id = ?
  AND (? IS NULL OR im.id > ?)  -- prev cursor, NULL = no lower bound
  AND im.id <= ?                -- this assistant's last_inbound_message_id
  AND cs.status = 'active'
  AND (cs.expires_at IS NULL OR cs.expires_at > now());
```

## Respond Function

A single channel-agnostic respond function resolves targets and emits delivery events. Per-channel adapters pick up their own events.

```typescript
inngest.createFunction({
  id: "respond",
  triggers: [{ event: "response/ready" }],
}, async ({ event, step }) => {
  const { conversationId, messageId } = event.data;

  // Resolve target sessions (all flags, deduped)
  const { sessions, conversation } = await step.run("find-targets", () =>
    getTargetSessions(conversationId, messageId, routingConfig));

  // Private conversations also deliver to receive:"all" sessions.
  // See sessions.md for receive modes and TTL lifecycle.
  if (conversation.isPrivate) {
    const allReceivers = await step.run("receive-all", () =>
      getReceiveAllSessions(conversationId));
    sessions.push(...allReceivers);
    dedup(sessions);
  }

  // Non-private conversations must route to exactly one session (source).
  // Multiple targets would leak group context into other chats.
  if (!conversation.isPrivate && sessions.length > 1) {
    logger.error({ conversationId, sessionIds: sessions.map(s => s.id) }, "non-private conversation routed to multiple sessions");
  }

  // Emit one delivery event per session — channel adapters listen for their own
  await step.sendEvent("deliver", sessions.map(s => ({
    name: "outbound/deliver",
    data: { messageId, channelSessionId: s.id, channelId: s.channelId, platformAddress: s.platformAddress },
  })));
});
```

The router never touches channel implementations. Adding a channel means registering a delivery handler (see [adapters.md](adapters.md)). The orchestrator never changes.

