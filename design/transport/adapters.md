# Adapter Contract `[proposed]`

The interface between channel adapters and the transport layer. First-party adapters (Telegram, Direct) use the same contract — designed for future third-party plugins.

## Overview

An adapter handles platform-specific IO. It receives a `Transport` scoped to its channel and interacts with the transport layer exclusively through it. The adapter never queries DB tables directly.

This boundary also enables future permission tuning — e.g. restricting a third-party adapter from creating `receive: "all"` sessions or accessing certain profiles.

## Transport

Contract pseudocode — return types shown as `Promise<T>` for readability. Actual implementations return `Result<T, TransportError>` (exceptions don't cross process boundaries for future plugin transport).

```typescript
interface Transport {
  // Sessions
  resolveSession(platformAddress: string): Promise<Session | null>;
  createConversation(platformAddress: string, platformUserHandle: string, opts: {
    isPrivate: boolean;
    receive?: "none" | "routed" | "all";  // default: "routed". Non-private: only "routed" allowed.
    expiresAt?: Date;
    profileId?: string;
  }): Promise<Session>;
  resumeConversation(
    platformAddress: string,
    platformUserHandle: string,
    target: { alias: string } | { conversationId: string },
    opts?: { receive?: "none" | "routed" | "all"; expiresAt?: Date },
  ): Promise<Session>;  // rejects if !isPrivate or user mismatch
  closeSession(sessionId: string): Promise<void>;
  extendSession(sessionId: string, expiresAt: Date): Promise<void>;

  // Profiles
  profiles: { list(platformUserHandle: string): Promise<Profile[]> };

  // Conversations (what's returned may be scoped by adapter permissions)
  conversations: { list(platformUserHandle: string): Promise<ConversationSummary[]> };

  // Inbound
  emit(sessionId: string, content: InboundContent, platformTs: Date): Promise<void>;
}

interface ConversationSummary {
  id: string;
  profileName: string;
  alias: string | null;
  lastMessagePreview: string;
  lastMessageAt: Date;
}
```

```typescript
type TransportError =
  | { code: "identity_rejected" }
  | { code: "conversation_not_found" }
  | { code: "profile_not_found" }
  | { code: "access_denied"; reason: string };
```

The adapter maps errors to platform-appropriate responses ("I don't know you", "No conversation named 'work'", etc.).

`channelId` is not a parameter — it's baked into the context when the runtime creates it for the adapter.

Identity resolution is internal — the adapter passes `platformUserHandle`, the transport resolves it based on the channel's identity mode (`fixed`, `mapped`, `create`). The adapter never sees userIds or touches `user_identities`.

## Operations

### Session management

- `resolveSession` — find the active session for a platform address (not closed, not expired)
- `createConversation` — resolve identity, create conversation, insert session row. Rejects if identity resolution fails (e.g. `mapped` mode, unknown handle).
- `resumeConversation` — link a platform address to an existing conversation by alias or conversationId. Rejects if the conversation is non-private or the user doesn't own it. Used by `/resume` (alias) and Web UI sidebar (conversationId).
- `closeSession` — set `status = 'closed'`, stops delivery. Used by `/new`.
- `extendSession` — bump `expiresAt` for TTL-managed sessions (heartbeat).

### Inbound

`emit` persists an `inbound_messages` row and emits `inbound/arrived`. The adapter normalizes platform input (strip @mentions, resolve refs, convert entities) before calling emit.

Control commands (`/new`, `/profile`, `/start`) are handled by the adapter using the session/profile methods directly — they never call `emit`.

### Outbound

The respond function (see [response-routing.md](response-routing.md)) resolves target sessions and emits `outbound/deliver` events — one per session. Each event carries `messageId`, `channelSessionId`, `channelId`, and `platformAddress`.

The runtime registers a delivery handler per channel that calls `adapter.deliver()` — the adapter implements platform-specific sending (Telegram `sendMessage`, Slack `postMessage`, SSE push, etc.). Delivery handlers check session status before calling deliver — closed or expired sessions are skipped silently.

## Adapter Flows

**First message (DM-style):**
```
session = transport.resolveSession(address)
if (!session) session = transport.createConversation(address, userHandle, { isPrivate: true })
transport.emit(session.id, content)
```

**`/new` command:**
```
transport.closeSession(currentSession.id)
session = transport.createConversation(address, userHandle, { isPrivate: true })
// respond with confirmation
```

**`/new coder` (with profile):**
```
transport.closeSession(currentSession.id)
session = transport.createConversation(address, userHandle, { isPrivate: true, profileId })
```

**`/profile list`:**
```
profiles = transport.profiles.list(userHandle)
// render profile list in platform-native UI
```

**`/resume work` (alias):**
```
transport.closeSession(currentSession.id)
session = transport.resumeConversation(address, userHandle, { alias: "work" })
```

**Web UI — view conversation:**
```
session = transport.resumeConversation(tabId, userHandle, { conversationId }, { receive: "all", expiresAt: now + TTL })
// heartbeat loop:
transport.extendSession(session.id, now + TTL)
```

## Web UI Delivery `[confirmed]`

SSE + POST — industry standard for AI chat apps (ChatGPT, Claude web, Vercel AI SDK). POST for inbound (calls `transport.emit()`), SSE for outbound (pushes `outbound/deliver` events). Consider WebSocket if bidirectional needs emerge (streaming tokens, typing indicators).

The bridge between Inngest and SSE is an in-memory EventEmitter — the `respond` Inngest function writes to DB and emits on the bus, the SSE handler picks up and pushes to the browser. Single process, zero additional infra.

On reconnect, `EventSource` auto-sends `Last-Event-ID`. Server replays missed messages from DB before resuming the live stream.

Evaluated alternatives: WebSocket (viable, may upgrade later), MQTT (overkill — pub/sub without an audience), WebTransport (no Node.js ecosystem), Inngest Realtime (no self-hosted support — [inngest/inngest#2537](https://github.com/inngest/inngest/pull/2537)).

## Adapter Interface

```typescript
// Factory: connect to platform, return a ready-to-use adapter
type StartAdapter<T extends Adapter = Adapter> = (transport: Transport, credentials: JsonValue) => Promise<T>;

// Instance: running adapter
interface Adapter {
  stop(): Promise<void>;
  deliver(platformAddress: string, content: JsonValue): Promise<void>;
  // Future: deliver a streaming chunk
  // deliverChunk?(platformAddress: string, chunk: JsonValue): Promise<void>;
}
```

The runtime reads channel rows from the DB, creates a scoped `Transport` per channel, and calls the registered `StartAdapter` for that channel type. It also registers a delivery handler (Inngest function filtered by channelId) that calls `adapter.deliver()` for each `outbound/deliver` event.

Adapters manage their own platform connection (polling, webhooks, WebSocket) — this is internal to `start()`.

## Response Rendering `[confirmed]`

The agent returns **markdown text**. Adapters handle all platform-specific rendering. No rich intermediate representation.

**Researched alternatives:**
- MS Bot Framework `Activity` model with `attachments` + `channelData`
- Adaptive Cards (semantic JSON UI)
- Botpress content types (carousel, card, choice)
- Custom `ResponseContent` with `actions[]`, `editMessageId`, etc.

**Decision:** All major AI agent frameworks (Letta, OpenClaw, Dust, Vercel AI SDK, LangChain) follow the same pattern: agent outputs text/markdown, adapters handle the rest. Markdown is the universal intermediate format.

- Each adapter converts markdown to platform-native format (Telegram MarkdownV2, Slack Block Kit, Discord embeds, etc.)
- Platform chrome (typing indicators, message splitting, formatting) is adapter-internal
- If rich rendering is ever needed (charts, interactive views), a standalone artifact renderer returns a URL that works in any channel

## Full Picture

```
Platform → Adapter → Transport → Transport Layer
Transport Layer → outbound/deliver event → Adapter delivery handler → Platform
```

Inbound: adapter calls `transport.emit()` (push). Outbound: runtime calls `adapter.deliver()` (pull).

## Trust Boundary

The adapter is a trust boundary. An untrusted or compromised adapter could:

- Fabricate content via `emit()` on any session it has access to
- Discover active sessions via `resolveSession()`
- Read response content from delivery events

For first-party adapters this is fine — they run in-process. For future third-party plugins, consider E2E encryption between the user's device and the agent, making the adapter a blind pipe that routes encrypted content without being able to read or forge it.
