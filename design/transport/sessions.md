# Channel Sessions `[proposed]`

How platform addresses map to conversations. Lifecycle, types, and cleanup.

## What is a Session

A channel session is a row in `channel_sessions` that links a platform address (Telegram chat ID, Slack thread ts, Web UI tab) to a conversation. Sessions track `status` and `receive` mode but have no lifecycle events or callbacks. The agent never sees sessions.

**Session resolution:** `resolveSession(platformAddress)` returns the most recent session for that address that is not closed and not expired. `/new` closes the current session and creates a new one — the old row stays in the DB.

## Session Properties

| Property | Purpose |
|-|-|
| `status` | `active` \| `closed` — closed sessions are excluded from routing and delivery |
| `receive` | `none` \| `routed` \| `all` — how this session receives responses |
| `expiresAt` | Session auto-expires after TTL, refreshed by heartbeat. Null = never expires. |

| receive | expiresAt | Example |
|-|-|-|
| `routed` | null | Telegram DM, Slack thread, Direct — normal routing, lives forever |
| `all` | set | Web UI tab — receives everything, cleaned up when tab closes |
| `all` | null | Monitoring dashboard — receives everything, never expires |
| `none` | null | Muted session — input only, no responses delivered |

## Session Creation

Adapters manage session lifecycle. Two invariants:

- A session must exist to create an inbound message (inbound_messages.channelSessionId FK)
- A session must exist to receive a response (routing resolves target sessions)

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
channel_sessions (
  id               UUID v7 PK,
  channel_id       UUID FK → channels NOT NULL,
  platform_address TEXT NOT NULL,                  -- opaque, channel-specific
  conversation_id  UUID FK → conversations NOT NULL,
  status           TEXT NOT NULL,                  -- 'active' | 'closed'
  receive          TEXT NOT NULL,                  -- 'none' | 'routed' | 'all'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ                    -- NULL = never expires
);
```

Indexes:
- `(channel_id, platform_address, id DESC)` — active session lookup
- `(conversation_id) WHERE status = 'active' AND receive = 'all' AND (expires_at IS NULL OR expires_at > now())` — receive-all session lookup for routing
