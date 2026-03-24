# Agents

## The Agentic Loop `[confirmed]`

No framework. Raw SDK while loop + tool dispatch. Implemented in `src/agent/loop.ts`.

The loop takes a system prompt, message history, tools, and an LLM provider. It calls the LLM, executes any tool calls, appends results, and repeats until the LLM returns `end_turn` or `max_tokens`. Returns the final text, full message history (defensive copy), and usage stats.

Provider-agnostic — depends on the `LlmProvider` interface, not the Anthropic SDK directly. See `src/llm/provider.ts`.

## Routing: Agents-as-Tools `[proposed]`

Define each sub-agent as a tool. Claude's native tool selection handles routing. No router agent needed.

```typescript
const tools: Tool[] = [
  {
    name: "memory_recall",
    description: "Search long-term memory for facts, preferences, past decisions",
    input_schema: { type: "object", properties: { query: { type: "string" } } }
  },
  {
    name: "memory_retain",
    description: "Store a fact in long-term memory",
    input_schema: { type: "object", properties: { fact: { type: "string" }, network: { enum: ["world", "bank", "opinion", "observation"] } } }
  },
  // ...
];
```

Sub-agents are just nested `runAgentLoop()` calls with their own system prompts and tool sets.

## Security: Orchestrator Holds Secrets `[confirmed]`

Sub-agents never see API keys. Orchestrator makes all external calls. Sub-agents return tool calls and text; orchestrator validates and executes.

## Conversation Layer `[proposed]`

The conversation layer manages the relationship between where messages come from (channels/chats), what dialogue they belong to (conversations), and how responses get delivered back.

### Key Concepts

**Channel** — A transport adapter (Telegram, CLI, Slack). Code interface that knows how to send/receive messages over a specific platform. See `src/channels/types.ts`.

**Chat** — A persistent endpoint within a channel. A Telegram DM with the bot is a chat. A CLI terminal session is a chat. A Slack thread is a chat. Each chat has a polymorphic **address** stored as `jsonb` (e.g. `{ channel: "telegram", chatId: 123456 }`). The address is opaque to the orchestrator — only the channel adapter that created it knows how to interpret it.

**Conversation** — A thread of dialogue with shared LLM context. When the orchestrator processes a message, it loads the conversation's history and assembles the context window from it. Conversations don't have an explicit lifecycle — they don't "end." They just go idle. `/new` on a channel creates a fresh conversation and relinks the chat to it. The old conversation stays in the DB permanently (reflection can still process it).

**The relationship:** A chat is linked to one active conversation at a time. A conversation can receive messages from multiple chats (e.g. same conversation accessible from Telegram and CLI). Over time, a chat may be linked to many different conversations (each `/new` creates one).

### Session Manager

The session manager resolves inbound messages to conversations:

1. Message arrives with `(channel, chatId, userId)` from the channel adapter
2. Look up chat by address → found? Get its linked `conversationId`. Not found? Create the chat.
3. Chat has no active conversation? Create one (using the user's default profile) and link the chat to it.
4. Now we have a `conversationId` — load history, run the agent, persist the response.

This is implemented in the `resolve-session` step of `handle-message.ts`.

### Profiles

A profile is a named agent configuration owned by a user: base prompt, LLM model, enabled tool set. Examples: "assistant" (general chat), "coder" (coding tasks), "buddy" (casual).

Conversations use a profile — the profile determines what the agent acts like. `/new coder` would create a conversation using the "coder" profile. Steering rules can be global or scoped to a specific profile.

### Message Flow

```
1. Channel adapter receives raw input (webhook, stdin, etc.)
2. Persist as InboundMessage immediately (durability — never lose a webhook payload)
3. Emit Inngest event (notification, not payload)
4. Debounce/batch (wait for user to finish typing)
5. Orchestrator picks up:
   a. Resolve session (find/create chat → find/create conversation)
   b. Combine pending InboundMessages into one conversation Message
   c. Load conversation history
   d. Assemble system prompt (profile base prompt + steering rules + memories)
   e. Run agentic loop
   f. Persist assistant Message
   g. Emit response event
6. Response router decides which chats receive the response
7. Channel adapters deliver to their respective endpoints
```

### Inbound Buffer

Raw messages are persisted to `inbound_messages` immediately on arrival — before any processing. This ensures durability for push-only channels (Telegram webhooks, Slack events) where the platform won't resend if we lose the payload.

Each inbound message has a status lifecycle: `pending` → `processing` → `processed`. When the orchestrator batches pending messages into a conversation turn, it creates one `messages` row and stamps all source `inbound_messages` rows with the resulting `messageId`.

### Message Batching (Debounce) `[proposed]`

When a user sends multiple messages rapidly, they should be batched into one LLM call rather than processed individually. Two configurable thresholds:

- **`idleTimeoutMs`** — time since last message, resets on each new message. "User stopped typing."
- **`maxWaitMs`** — time since first unbatched message, never resets. "Don't wait forever."

Fire when either threshold triggers. Both are optional — see `data-model.md` for the full configuration matrix.

### Resume Policy `[proposed]`

When the orchestrator finishes a turn and there are messages that were buffered while it was busy, the **resume policy** controls what happens:

- **`debounce`** — re-apply debounce rules to the buffered messages (user might still be typing)
- **`flush`** — process buffered messages immediately (prioritize responsiveness)
- **`await_input`** — hold until user sends another message or confirms (good for review/coding workflows where the user wants to see the response before the next batch runs)

Configurable per profile.

### Delivery & Response Routing `[proposed]`

A conversation message (user or assistant) may be delivered to multiple chats. The `deliveries` table tracks each delivery: which message, which chat, direction (inbound/outbound), status (pending/sent/delivered/failed).

Response routing is a separate concern from the orchestrator. The orchestrator emits a `message/response` event. A response router (not yet implemented) decides which chats receive it based on user configuration: reply-to-source, reply-to-all, reply-to-preferred, etc.

### Concurrency `[confirmed]`

One message batch at a time per chat. Inngest `concurrency: { limit: 1, key: chatId }`. Second batch waits in Inngest's queue until the first completes. This is the standard pattern — Letta explicitly documents that agents are not thread-safe per conversation.

### Context Window Management `[research]`

Each invocation assembles context from:
1. Profile base prompt + steering rules
2. Relevant memories from Hindsight recall
3. Conversation message history

Two-tier memory architecture — no separate in-session memory layer needed:
- **Conversation messages** (hot) — recent turns, loaded directly into context
- **Hindsight** (archival) — facts extracted by the Observer from past conversations, recalled by semantic query

When a conversation exceeds the context budget, old messages are compacted. The Observer has already extracted important facts into Hindsight, so cross-session knowledge isn't lost. Within a single session, compaction strategy matters more — a relevant early message shouldn't be dropped just because it's old.

**Compaction strategies under consideration (not decided):**

| Strategy | How it works | Tradeoff |
|---|---|---|
| **Trimming** | Drop oldest messages, keep first + last N | Simplest. May lose important mid-conversation context. |
| **Trimming + retrieval** | Trim old messages, use Hindsight `recall()` to fill gaps | Good default. Depends on Observer having extracted the right facts — but Observer may not have run yet on an active conversation. |
| **Summarization** | LLM condenses old messages into a short summary | Preserves intent. Costs an LLM call per compaction. Can lose details. Claude Code uses this approach. |
| **Observation masking** | Score each message's relevance to the current query, drop low-scoring ones regardless of position | Best context quality. Anthropic research shows it halves costs vs summarization. Needs a relevance scorer (embedding similarity or heuristics). |

These could be configurable per profile — a coding profile might benefit from masking (keep relevant code context, drop chit-chat), while a casual chat profile might work fine with simple trimming.

**For MVP:** Not needed — Claude's 200K context window covers very long conversations. Implement when we see real context pressure.

## Channel Interface `[confirmed]`

```typescript
interface Channel {
  readonly name: string;
  start(onMessage: (msg: InboundMessage) => void): void;
  write(text: string): void;
  stop(): void;
}

interface InboundMessage {
  channel: string;   // "cli", "telegram", etc.
  chatId: string;    // channel-specific endpoint ID
  userId: string;    // who sent it
  text: string;
  timestamp: Date;
}
```

Channel adapters produce `InboundMessage` with flat typed fields. The orchestrator composes `{ channel, chatId }` into the polymorphic `address` jsonb when looking up or creating a chat row. This is the right boundary — typed at the adapter layer, polymorphic at the storage layer.

## AI Steering Rules `[confirmed]`

Rules stored as PostgreSQL rows. Injected into system prompts at invocation time. Can be global or scoped to a profile. Managed by the `DefaultPromptSource` which loads the profile's base prompt and layers applicable rules on top.

Stage 1 evolution edits these rows. Stage 5 signal pipeline auto-proposes new rules from conversation signals.

## Crash Recovery `[confirmed]`

Handled by Inngest durable steps — each `step.run()` checkpoints. Crash between steps resumes from last completed step. No application-level cursor needed.

## Internal Tag Stripping `[confirmed]`

Agent uses `<internal>` tags for reasoning visible to orchestrator but not user:

```typescript
function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}
```

## Activity-Based Timeouts `[proposed]`

From NanoClaw. Timeout resets on every tool call or partial response. Only kill truly stuck agents, not long-running ones that are making progress.

## Dual-Mode Monitoring `[research]`

From memU. For ingestion agents: cheap embedding scan first, LLM only when relevant. Saves ~30% of ingestion costs by filtering before LLM processing.
