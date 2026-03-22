# Agents

## The Agentic Loop (~30 Lines)

No framework. Raw SDK while loop + tool dispatch.

```typescript
async function runAgent(
  systemPrompt: string,
  userMessage: string,
  tools: Tool[],
  toolHandlers: Record<string, (args: any) => Promise<any>>
): Promise<string> {
  const messages: Message[] = [{ role: "user", content: userMessage }];

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      system: systemPrompt,
      messages,
      tools,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      return response.content.filter(b => b.type === "text").map(b => b.text).join("");
    }

    // Execute tool calls
    const toolResults = [];
    for (const block of response.content.filter(b => b.type === "tool_use")) {
      const handler = toolHandlers[block.name];
      try {
        const result = await handler(block.input);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      } catch (err) {
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }
}
```

## Routing: Agents-as-Tools

Define each sub-agent as a tool. Claude's native tool selection handles routing. No router agent needed.

```typescript
const tools: Tool[] = [
  {
    name: "email_agent",
    description: "Draft, search, or summarize emails",
    input_schema: { type: "object", properties: { task: { type: "string" } } }
  },
  {
    name: "finance_agent",
    description: "Query spending, budgets, subscriptions",
    input_schema: { type: "object", properties: { query: { type: "string" } } }
  },
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
  {
    name: "schedule_task",
    description: "Create, modify, or delete a scheduled task",
    input_schema: { ... }
  },
  // ...
];
```

Sub-agents are just nested `runAgent()` calls with their own system prompts and tool sets.

## Security: Orchestrator Holds Secrets

Sub-agents never see API keys. Orchestrator makes all external calls. Sub-agents return tool calls and text; orchestrator validates and executes.

## Channel Registry (From NanoClaw)

Self-registration factory pattern. Each channel module calls `registerChannel()` on import.

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
}

interface InboundMessage {
  channel: string;
  chatId: string;
  userId: string;
  text: string;
  timestamp: Date;
}

const channelFactories = new Map<string, () => Channel | null>();

function registerChannel(name: string, factory: () => Channel | null) {
  channelFactories.set(name, factory);
}

// On startup: instantiate all registered channels
function initChannels(): Channel[] {
  return [...channelFactories.entries()]
    .map(([name, factory]) => factory())
    .filter((ch): ch is Channel => ch !== null);
}
```

## Per-Conversation Context

Each conversation gets its own:
- Session history (PostgreSQL rows)
- Memory partition (Hindsight namespace or agent_id filter)
- System prompt augmentation (relevant memories prepended)

## GroupQueue (From NanoClaw)

Per-conversation FIFO ordering with global concurrency limit.

```typescript
// Default: max 3 parallel LLM calls across all conversations
// Within a conversation: strict FIFO (no interleaving)
// Tasks (extraction, ingestion) prioritized over user messages
```

Prevents a chatty conversation from starving background work. Implement as BullMQ named queues with rate limiting.

## Internal Tag Stripping (From NanoClaw)

Agent uses `<internal>` tags for reasoning visible to orchestrator but not user:

```typescript
function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}
```

## Activity-Based Timeouts (From NanoClaw)

Timeout resets on every tool call or partial response. Only kill truly stuck agents, not long-running ones that are making progress.

## Crash Recovery (From NanoClaw)

Persist message cursor to PostgreSQL before processing. Restart from last persisted cursor on crash. At-least-once delivery guarantee.

```typescript
// Before processing message:
await db.query('UPDATE conversations SET cursor = $1 WHERE id = $2', [messageId, conversationId]);
// On restart:
const { cursor } = await db.query('SELECT cursor FROM conversations WHERE id = $1', [conversationId]);
// Resume from cursor
```
