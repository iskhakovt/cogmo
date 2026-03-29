# Messaging Architecture `[proposed]`

How messages flow from platform to agent and back, across all channels.

## Core Concepts

| Concept | What it is | Owned by |
|-|-|-|
| Channel | Platform connection. Holds credentials (token, OAuth). | Org |
| User | Conversation owner. Owns conversations and personal memory. Identified on platforms via `user_identities`. | Org |
| Channel Session | Maps a platform address to an active conversation. Invisible to the agent. | Channel adapter |
| Inbound Message | Raw normalized platform input. Staging buffer for debounce batching. References the channel session it arrived through. Immutable. | Channel adapter |
| Conversation | Agent dialogue thread. Shared LLM context, linked to a profile. | Agent |
| Message | One agentic conversation turn (user or assistant). A user message may consolidate multiple inbound messages; an assistant message is always a single response. | Agent |

> **"Conversation"** always means the agent dialogue (our DB entity). **"Channel Session"** maps a platform address to a conversation — the channel-side link. The agent never sees channel sessions.

## Data Model

| Table | Key columns | Notes |
|-|-|-|
| `channels` | type, credentials (encrypted), identityMode | Org-level. |
| `users` | id | Conversation owners. |
| `user_identities` | userId, channelId, platformHandle | Maps platform handle on a channel to internal UUID. IS the allowlist. |
| `profiles` | name, model | Org-scoped — shared across users. |
| `channel_sessions` | id, channelId, platformAddress, conversationId, status, receive, expiresAt | Maps platform address to conversation. `status`: `active` \| `closed`. `receive`: `none` \| `routed` \| `all`. See [sessions.md](sessions.md). |
| `conversations` | id, userId, profileId, isPrivate | Agent-side. No reference to channels. `isPrivate` controls memory scope. |
| `messages` | id, conversationId, role, content, lastInboundMessageId | Immutable. `lastInboundMessageId` on all messages for attribution. |
| `inbound_messages` | id, channelSessionId, conversationId, content, platformTs | Immutable. `platformTs` = when user sent it (from platform API). `conversationId` denormalized from channel_sessions for query performance. User derived from `conversation.userId`. |

### Core Table Schemas

Source of truth is the Drizzle ORM schema in `src/<module>/store/schema.ts`. These capture design intent — validate against code before treating as final. Transport-specific tables (`channel_sessions`, `inbound_messages`, `user_identities`) are documented in their respective docs.

```sql
channels (
  id               UUID v7 PK,
  type             TEXT NOT NULL,              -- 'direct', 'telegram', 'slack', 'web'
  credentials      JSONB NOT NULL,             -- encrypted: token, OAuth, etc.
  identity_mode    TEXT NOT NULL,              -- 'fixed' | 'mapped' | 'create'. See identity.md.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

profiles (
  id               UUID v7 PK,
  name             TEXT NOT NULL UNIQUE,       -- 'assistant', 'coder', 'buddy', etc.
  base_prompt      TEXT NOT NULL,
  model            TEXT NOT NULL,              -- LLM model identifier
  tool_set         JSONB NOT NULL,             -- enabled tool names
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  -- Org-scoped for now. May extend to per-user (add user_id FK, change UNIQUE to (user_id, name)) later.
);

conversations (
  id               UUID v7 PK,
  user_id          UUID FK → users NOT NULL,
  profile_id       UUID FK → profiles NOT NULL,
  is_private       BOOLEAN NOT NULL,           -- controls memory scope. See identity.md.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

messages (
  id                       UUID v7 PK,
  conversation_id          UUID FK → conversations NOT NULL,
  role                     TEXT NOT NULL,       -- 'user' | 'assistant'
  content                  JSONB NOT NULL,      -- text, images, files, voice transcripts
  last_inbound_message_id  UUID NOT NULL,        -- attribution cursor. See debounce.md.
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Index: (conversation_id, id) — primary query for context assembly
```

## Identity, Attribution & Memory Scoping

See [identity.md](identity.md) — identity modes (`fixed`, `mapped`, `create`), user attribution via `conversations.userId`, memory scoping via `isPrivate`, group chat constraints.

## Ownership Boundaries

**Channel side (adapters via `Transport` interface):**

- **Writes:** `inbound_messages`, `channel_sessions`
- **Reads:** `channel_sessions` (resolve session), `user_identities`
- **Creates:** conversations, sessions
- **Manages:** session lifecycle (create, close, extend), identity resolution

**Routing layer:**

- **Reads:** `channel_sessions` (resolve delivery targets), `inbound_messages` (source routing)
- **Writes:** none — emits `outbound/deliver` events

**Agent side (orchestrator):**

- **Writes:** `messages`
- **Reads:** `inbound_messages` (to build turn), `messages` (history)
- **Never touches:** `channel_sessions`, `channels`, `user_identities`

Sequential handoff — channel side is done writing before orchestrator reads. The event bus is the boundary.

## Inbound Flow

1. Channel adapter receives raw platform input (webhook, polling, stdin)
2. Normalize: strip @mention, resolve platform refs, convert entities to markdown
3. Resolve or create session via `transport.resolveSession()` / `transport.createConversation()` (identity resolved internally)
4. Emit via `transport.emit(sessionId, content: InboundContent)` — persists inbound message + emits `inbound/arrived`

**Control commands** (`/new`, `/start`, `/profile`) intercepted by adapter before step 2. No persist, no event, no LLM call. `/new` closes the current session and creates a new conversation + session. See [sessions.md](sessions.md).

## Agent Pipeline

Shared core — same for all platforms. The agent never knows which platform the message came from.

1. Receive `inbound/ready` event (from debounce layer)
2. Load unbatched inbound messages (`WHERE conversationId = ? AND id > lastResponse.lastInboundMessageId`, where `lastResponse` is the previous assistant message — null = load all)
3. Batch into one user `messages` row (set `lastInboundMessageId` = max inbound ID)
4. Load conversation history
5. Assemble system prompt (profile base prompt + steering rules + memories)
6. Run agentic loop
7. Persist assistant `messages` row (set `lastInboundMessageId` = same)
8. Emit `response/ready` event

Concurrency: `limit: 1, key: conversationId` — one batch at a time per conversation. Second batch queues in Inngest until the first completes.

## Event Bus

Four boundary events connect adapters to the agent pipeline. Debounce-internal events (`debounce/idle`, `debounce/maxwait`, `debounce/cancel`) documented separately in [debounce.md](debounce.md).

| Event | Payload | Emitter | Consumers |
|-|-|-|-|
| `inbound/arrived` | conversationId, inboundMessageId | Adapter | Debounce layer |
| `inbound/ready` | conversationId, triggerInboundId (nullable) | Debounce layer | Orchestrator |
| `response/ready` | conversationId, messageId | Orchestrator | Router |
| `outbound/deliver` | messageId, channelSessionId, channelId, platformAddress | Router | Per-channel adapters |

Events carry minimal data — IDs and routing info. Consumers derive what they need from their own tables.

`inbound_messages` exists because of debounce. Without debounce, every inbound message IS a conversation turn — one table suffices. With debounce, raw messages need a staging area before batching into turns. See [debounce.md](debounce.md) for the full design.

## Inbound Message / Message Attribution

All messages carry `lastInboundMessageId` — "the latest inbound message ID when this message was created." Set on every insert for simplicity. Attribution uses the range between consecutive **assistant** messages' cursors (not user messages — handles dangling user turn recovery correctly).

```sql
-- Which inbound messages were processed into this response?
SELECT * FROM inbound_messages
WHERE conversation_id = ?
  AND id > prev_assistant_msg.last_inbound_message_id
  AND id <= this_assistant_msg.last_inbound_message_id;
```

No join table, no FK from inbound to messages. Both tables stay immutable (insert-only). The cursor is set once at message creation.

**Why ID cursor over timestamp?** Monotonic UUIDv7, no clock skew, no precision edge cases. Same pattern as Kafka offsets and Stripe settlement cursors.

## Response Routing

`response/ready → {routing logic} → outbound/deliver per session`. A single channel-agnostic router resolves targets and emits delivery events. Per-channel adapters handle their own deliveries. See [response-routing.md](response-routing.md).

## Streaming `[proposed]`

Real-time token delivery for streaming-capable channels (Web UI). Batch channels (Telegram, Slack) receive the complete message via `outbound/deliver` after persist.

Routing targets are computable BEFORE the response exists — conversationId, source sessions, lastInbound session, `receive: "all"` sessions are all known at turn start. This enables pre-evaluated routing: determine WHERE to deliver, then stream content to streaming targets while the LLM generates.

```
1. Load inbound messages, build user turn (existing)
2. Pre-evaluate routing targets → partition into streaming vs batch
3. Start LLM call (stream: true)
4. For each chunk: push to streaming targets (in-memory EventEmitter → SSE)
5. On completion:
   a. Persist assistant message
   b. Emit response/ready (always — canonical completion signal)
   c. Respond function → outbound/deliver for ALL targets
      - Streaming targets: deliver() sends messageId (content already streamed)
      - Batch targets: deliver() sends full message content
```

Streaming happens INSIDE the orchestrator. The EventEmitter is in-process — the SSE handler listens and pushes to the browser. Zero additional infrastructure.

For v0 (Telegram only): no streaming needed. Batch delivery only.

## Channels

| Channel | Type | Sessions per instance | Notes |
|-|-|-|-|
| Direct | Programmatic | Many | Event-driven (Inngest). Console script, automations, tests. |
| Telegram | Interactive | 1 (personal DM) | Primary. See [telegram.md](telegram.md). |
| Slack | Interactive | Many (threads, DMs, channels) | @mention to invoke, thread = conversation |
| Discord | Interactive | Many (same as Slack) | @mention to invoke, thread = conversation |
| Web UI | Interactive | Many | Full control. Settings, memory browser, history. |
| API | Programmatic | Many | JSON in/out. Automations and integrations. |

Email is a tool (`send_email`), not a channel — the agent sends email as an action.

### Thread & Mention Model `[confirmed]`

Researched production bots (Claude, ChatGPT, Dust, GitHub Copilot) — all require @mention. Auto-reply in threads was tried and failed due to noise, cost, loops, rate limits, and wrong-context responses.

| Context | Bot responds to | Why |
|-|-|-|
| DM (any platform) | Every message | 1:1 with bot, no ambiguity |
| Channel/group thread | @mention only | Avoids noise, cost, loops |

**Thread mapping:** One thread = one conversation. @mention in a channel creates a thread. Subsequent @mentions in the same thread continue the conversation.

### Conversation History Ownership `[proposed]`

**Our DB owns the history.** Platform APIs (Slack, Discord) are supplementary — used to load human-to-human messages for context at invocation time, but our DB is the primary store.

**Why not rely on platform history:**
- Slack free plan: 90-day limit, permanent deletion after 1 year
- Admin retention policies can auto-delete at any time
- User message deletion breaks thread context
- Slack API rate limits: 1 req/min for non-marketplace apps (May 2025)
- Letta (the one agent that does persistent memory) stores its own history for the same reasons

**What we store:**
- User messages directed at the bot (@mention text, DM text)
- Bot responses
- Human-to-human messages observed in threads (for context quality)

**Retention lifecycle** (requires Observer, future work):
1. **Active** — messages in DB, used for conversation context
2. **Extracted** — Observer has processed them into Hindsight memories
3. **Recycled** — raw messages deleted per channel retention policy, facts live on in memory

Per-channel retention policies (e.g., delete Slack messages after Observer extraction) address platform compliance. For v0, store everything.

**Observer implication:** Multi-channel means the Observer must handle both long conversations (Telegram DM) and many short fragments (Slack threads). Different extraction patterns — summarize vs aggregate-and-connect. Not a blocker for channel design, but a constraint for Observer design.

## Platform Mapping

| | Direct messages | Group chats | Web UI (future) |
|-|-|-|-|
| Channel to Chats | 1:many (one per user) | 1:many (threads) | 1:many (tabs) |
| Address to Conversations | 1:many (`/new`) | 1:1 (thread = conv) | many:many (sidebar) |
| Turn trigger | Every message | @mention only | Every message |
| Delivery | sendMessage | postMessage(thread) | SSE + POST |
| Thinking indicator | sendChatAction | Emoji reaction | Custom spinner |

## Interfaces

See [adapters.md](adapters.md) for the `StartAdapter` / `Adapter` / `Transport` interfaces.

Agent returns markdown text. Adapters handle platform-specific rendering. No rich intermediate representation.

## Open Questions

| Question | Status |
|-|-|
| Inbound message retention | Not designed — when to delete after Observer extraction |
| Observer trigger mechanism | Not designed |
