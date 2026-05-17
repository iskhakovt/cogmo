# Channel Sessions `[proposed]`

How platform addresses map to conversations. Lifecycle, types, and cleanup.

## What is a Session

A channel session is a row in `channel_sessions` that links a platform address (Telegram chat ID, Slack thread ts, Web UI tab) to a conversation. Sessions track `status` and `receive` mode but have no lifecycle events or callbacks. The agent never sees sessions.

`status` records **reachability** — whether we can deliver to the user on this channel right now. It is not a record of conversational engagement; that is inferred from `messages.created_at` on the conversation. A Telegram chat that has been quiet for hours keeps `status='active'` indefinitely, because the bot can still DM the chat_id — the user is "idle," not "unreachable." Web UI sessions additionally carry `expires_at` driven by heartbeats; an unexpired `active` Web UI session means a tab is alive.

**Session resolution:** `resolveSession(platformAddress)` returns the most recent session for that address that is not closed and not expired. If the conversation has been quiet longer than the idle window, `resolveSession` lazy-rotates — it closes the stale session and returns null, prompting the caller to create a fresh conversation for the inbound that just arrived.

## Session Properties

| Property | Purpose |
|-|-|
| `status` | `active` \| `closed` — reachability lifecycle. Closed sessions are excluded from routing and delivery. |
| `receive` | `none` \| `routed` \| `all` — how this session receives responses |
| `expiresAt` | Session auto-expires after TTL, refreshed by heartbeat. Null = never expires. |

| receive | expiresAt | Example |
|-|-|-|
| `routed` | null | Telegram DM, Slack thread, Direct — normal routing, lives forever |
| `all` | set | Web UI tab — receives everything, cleaned up when tab closes |
| `all` | null | Monitoring dashboard — receives everything, never expires |
| `none` | null | Muted session — input only, no responses delivered |

## Session Close Paths

`status` flips to `closed` in three places:

1. **Explicit end** — `/new`, `/end`, or profile change. `swapSession` closes the old row and opens a fresh one in a single transaction.
2. **Lazy rotation on stale inbound** — when a new inbound arrives on a session whose conversation's last message is older than the idle window. The next inbound starts a fresh conversation.
3. **Scheduled fire into an idle conversation** — the fire handler treats this like a synthetic `/new`, rotating every reachable channel for the user+profile onto a fresh conversation (see [scheduling.md](../scheduling.md) → *Synthetic conversation turn*).

The idle timer does **not** close sessions. Its only job is emitting `conversation/idle` for the Observer; reachability is unrelated to whether the user is mid-conversation.

## Session Creation

Adapters manage session lifecycle. Two invariants:

- A `user`-source inbound message points at an originating session (`inbound_messages.channel_session_id` not null). `scheduled`-source inbounds have no originating session — their `channel_session_id` is null and a check constraint enforces the link.
- A session must exist to receive a response (routing resolves target sessions).

Session lifecycle is adapter-specific: Telegram creates a long-lived session on first message, Slack team chats spawn a session per thread, Web UI maintains a session while a tab is open.

### `/new` Command
1. Close current session (`status = 'closed'`)
2. Create new conversation via `createConversation()`
3. Insert new session row (active, pointing to new conversation)

Closing the old session stops pending responses from the old conversation from being delivered. Any in-flight `outbound/deliver` events check session status before sending — closed = skip silently. This handles the "response arrives after `/new`" edge case without cancelling orchestrator runs.

### `/end` Command

Close current session (`status = 'closed'`) without creating a new one. The next inbound message will create a fresh conversation via the normal first-message flow (`resolveSession` returns null → `createConversation`). Same in-flight behavior as `/new`.

**TODO:** Consider halting in-flight processing (orchestrator run) on session closure. Currently the orchestrator finishes and the response is silently dropped at delivery. Halting would save compute but adds complexity (cancellation signal from adapter to orchestrator).


### Web UI Sessions

Created when the user opens a conversation in the Web UI:

1. User navigates to conversation → adapter inserts session (`receive: "all", expiresAt: now + TTL`)
2. Client sends heartbeat every N seconds → adapter updates `expiresAt = now + TTL`
3. User closes tab / navigates away → heartbeats stop → session expires

Web UI sessions use `receive: "all"` (get all responses) and `expiresAt` TTL (cleaned up when tab closes).

## Reachability Lookups

`findReachableChannelsForUserProfile(userId, profileId)` returns distinct `(channelId, platformAddress, receive)` tuples for every channel the user has ever used on this profile, ordered with the latest `receive` mode per address. Closed sessions are included as a source of `(channelId, platformAddress)` tuples — a `/end`-ed Telegram chat is still reachable, and a rotation can `swapSession` onto a fresh conversation. Sessions with `expires_at` in the past are excluded (Web UI heartbeat stopped).

This is the canonical "where can we reach this user for this profile?" query, used by the scheduled-fire dispatcher when it rotates onto a fresh conversation.

## Cleanup

**TODO:** Consider periodic cleanup of expired and closed sessions. Both are already excluded from routing, so cleanup is only about table size — may never be needed at personal scale.

## Session and Routing

Sessions are the delivery targets for response routing. See [response-routing.md](response-routing.md) for strategies.

- **`source` routing** traces inbound messages back to their `channelSessionId`
- **`lastInbound` routing** finds the most recent inbound message's session
- **`receive: "all"` sessions** receive all responses for the conversation regardless of routing config (private conversations only)

## Aliases

Conversations can carry a human-readable alias (`'work'`, `'shopping'`) to enable resume-by-name and friendly listings. Aliases are user-set, not auto-generated:

- **Set/clear:** `transport.conversations.setAlias(conversationId, alias | null)`. Telegram surfaces this as `/name <alias>`. Web UI uses an inline rename.
- **Uniqueness:** scoped per user. Conflicts return `alias_taken`.
- **Storage:** the `aliases` table (see [data-model.md](../data-model.md), Phase 2). Separate table because aliases are sparse and users may want to rename without touching the conversation row.
- **Privacy:** only `isPrivate: true` conversations can carry aliases. Group conversations are scoped to their platform thread.

LLM-suggested auto-naming (e.g., generate an alias from the first turn) is a future enhancement — see todo. Until then, conversations without an alias appear in `/sessions` by their last-message preview.

## Non-Private Conversations

Sessions on `isPrivate: false` conversations are constrained:

- **Forced `source` routing** — responses stay in the originating thread
- **No aliases or resume** — group conversations are scoped to their platform thread (`setAlias` rejects with `access_denied`)
- **Not visible in Web UI**

## Schema

```sql
-- Enums
channel_session_status   AS ENUM ('active', 'closed');
channel_session_receive  AS ENUM ('none', 'routed', 'all');
inbound_message_source   AS ENUM ('user', 'scheduled');

channel_sessions (
  id               UUID v7 PK,
  channel_id       UUID FK → channels NOT NULL,
  platform_address TEXT NOT NULL,                          -- opaque, channel-specific
  conversation_id  UUID FK → conversations NOT NULL,
  status           channel_session_status NOT NULL,
  receive          channel_session_receive NOT NULL,
  expires_at       TIMESTAMPTZ,                            -- NULL = never expires
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

inbound_messages (
  id                  UUID v7 PK,
  channel_session_id  UUID FK → channel_sessions,            -- NULL ⟺ source='scheduled'
  conversation_id     UUID FK → conversations NOT NULL,
  content             JSONB NOT NULL,                        -- InboundContentSchema
  platform_ts         TIMESTAMPTZ NOT NULL,
  source              inbound_message_source NOT NULL,
  scheduled_fire_key  TEXT,                                  -- NOT NULL ⟺ source='scheduled'
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((source = 'user' AND channel_session_id IS NOT NULL AND scheduled_fire_key IS NULL)
      OR (source = 'scheduled' AND channel_session_id IS NULL AND scheduled_fire_key IS NOT NULL))
);
-- Partial unique index — scheduled-fire idempotency
CREATE UNIQUE INDEX uq_inbound_scheduled_fire_key
  ON inbound_messages (scheduled_fire_key)
  WHERE scheduled_fire_key IS NOT NULL;
```

Indexes:
- `(channel_id, platform_address, id DESC)` — active session lookup
- `(conversation_id) WHERE status = 'active' AND receive = 'all'` — receive-all session lookup for routing
