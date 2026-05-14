# Agents

## The Agentic Loop `[confirmed]`

No framework. Raw SDK while loop + tool dispatch. Implemented in `src/agent/loop.ts`.

The loop takes a system prompt, message history, tools, and an LLM provider. It calls the LLM, executes any tool calls, appends results, and repeats until the LLM returns `end_turn` or `max_tokens`. Returns the final text, full message history (defensive copy), `newMessages` (only the messages produced this invocation — intermediate tool_use/tool_result turns + final assistant), and usage stats. The orchestrator persists all `newMessages` with full `ContentBlock[]` content — tool invocations are available in the conversation history for replay, compaction, and Stage 1 correction extraction.

Provider-agnostic — depends on the `LlmProvider` interface, not the Anthropic SDK directly. See `src/llm/provider.ts`.

## Tool Architecture `[confirmed]`

### Capability Interface

Tools interact with external systems exclusively through a **`Service`** interface — a typed, namespaced contract. Tools never receive raw service references (`MemoryProvider`, `Database`, etc.).

```typescript
interface Service {
  memory: {
    recall(query: string, opts?: RecallOptions): Promise<RecallResult>;
    retain(content: string, opts?: RetainOptions): Promise<void>;
  };
  files: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    list(prefix?: string): Promise<FileEntry[]>;
  };
  coreMemory: {
    get(): Promise<ReadonlyArray<CoreMemoryBlock>>;
    update(key: string, content: string): Promise<void>;
  };
}
```

Binary attachments (images, PDFs) are handled by a separate `AttachmentStore` interface in the transport layer, not exposed to agent tools. See `src/transport/attachment-store.ts`.

The orchestrator creates scoped capabilities by wrapping real services:

```typescript
function createService(memory: MemoryProvider, userId: string, profile: Profile): Service {
  return {
    memory: {
      recall: (query, opts) => memory.recall(userId, query, { ...opts, tags: profileTags(profile) }),
      retain: (content, opts) => memory.retain(userId, content, { ...opts, tags: profileTags(profile) }),
    },
  };
}
```

This is the ACL boundary — the orchestrator decides which capabilities to expose, scopes them to the current user and profile, and can log or rate-limit at this layer.

**Why capabilities, not service injection:** Most agent frameworks (OpenAI Agents SDK, Vercel AI SDK, Mastra) pass rich context objects with direct service references. This works when tools are trusted first-party code. We design for the plugin model from day 1 — the capability interface is the same contract whether tools run in-process or across a WASM boundary. For WASM plugins (future), a bridge implements `Service` by routing method calls through a single dispatch function across the boundary. Tools always see the same typed interface regardless of execution environment.

**Scoping:** Capabilities are pre-scoped by the orchestrator per conversation turn — userId, profile access rules baked in, reused across all tool calls in that turn. `capabilities.memory.recall(query)` already targets the right user's bank with the right access filters — the tool doesn't choose whose data to access.

### Input Validation

Every tool input is validated at runtime before the handler executes.

- **In-process tools (TypeScript):** Define input with Zod. `z.toJSONSchema()` generates the JSON Schema sent to the LLM. Zod validates + parses input, handler receives typed data.
- **Plugin tools (WASM, future):** Provide JSON Schema directly (language-agnostic). Host validates with a JSON Schema validator (ajv or alternative — decide at implementation time). Handler receives validated-but-untyped input.

JSON Schema is the universal contract format. Zod is a convenience for TypeScript tool authors, not a system requirement. No dynamic JSON Schema → Zod conversion needed.

Validation failure → `tool_result` with `isError: true` + error details → LLM can retry with corrected input.

### Tool Definition

```typescript
// Universal tool spec — stored in registry, execution-environment agnostic
interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (input: Record<string, unknown>, capabilities: Service) => Promise<string>;
}

// Typed helper for in-process TypeScript tools (Zod convenience)
function defineTool<T>(opts: {
  name: string;
  description: string;
  schema: ZodSchema<T>;
  handler: (input: T, capabilities: Service) => Promise<string>;
}): ToolSpec;
```

### Handler Signature

```typescript
type ToolHandler = (
  input: Record<string, unknown>,   // LLM-provided, validated against inputSchema
  capabilities: Service,    // orchestrator-provided, pre-scoped dispatch
) => Promise<string>;
```

Two args: **data in** (from LLM) and **capabilities** (from orchestrator). No context object — capabilities are pre-scoped, so tools don't need per-request metadata like userId. Files and attachments are accessed through capabilities (`readAttachment(id)`), not passed as input.

### Tool Registry

The `ToolRegistry` holds `ToolSpec` entries. The agentic loop uses it to:
1. Generate tool definitions for the LLM (name + description + JSON Schema)
2. Resolve tool calls by name
3. Validate input against schema
4. Execute handler with scoped capabilities

The orchestrator constructs scoped `Service` once per conversation turn and passes it to the agentic loop. The loop threads it through `executeToolCalls` to each handler.

### Concurrent Tool Execution `[confirmed]`

Claude (and most modern tool-use protocols) can emit multiple `tool_use` blocks in a single assistant turn. The protocol requires every `tool_use.id` answered by exactly one `tool_result` before the next inference, so the orchestrator collects results for the whole batch before continuing — synchronous fan-out, not async-continue. Long-running detached work belongs on the scheduling tables, not the tool executor.

**Opt-in safety.** Each `ToolSpec` carries an optional `parallelSafe: boolean` (default `false`). `true` declares the handler has no observable ordering dependency on sibling tool calls — independent provider calls, read-only HTTP, pure compute. `false` is required for any handler that writes shared state where a concurrent sibling write or read could race (`core_memory_update`, `write_file`, `delegate_coding`, `register_skill`).

**Consecutive coalescing.** `executeToolCalls` walks the LLM's emission order, folds each maximal run of parallelSafe entries into one `Promise.all`, and leaves every unsafe entry as its own singleton group. A mix like `[image, image, image, core_memory_update, web_search]` yields three groups — `{img, img, img}` → `{update}` → `{search}` — fanned out within each, sequenced between.

**Why consecutive coalescing rather than group-by-safety:** the LLM's emission order is treated as load-bearing for unsafe writes. If the model emits `[read_file, write_file, read_file]`, the second read should observe the write. Reordering by safety would let safe reads run concurrently with — or before — the write. Two adjacent unsafe entries also stay split into singletons, so `[write_file(p), write_file(p)]` still runs serially.

**Unknown tools** short-circuit to an error `tool_result` with no side effects and coalesce with safe runs.

Reference: `executeToolCalls` in `src/agent/loop.ts`. See `design/decisions.md` for the tradeoff that drove this shape.

## Routing: Agents-as-Tools `[proposed]`

Define each sub-agent as a tool. Claude's native tool selection handles routing. No router agent needed. Sub-agents are just nested `runAgentLoop()` calls with their own system prompts and tool sets.

## Security: Orchestrator Holds Secrets `[confirmed]`

Sub-agents never see API keys. Orchestrator makes all external calls. Sub-agents return tool calls and text; orchestrator validates and executes.

## Messaging Architecture

How messages flow from platform to agent and back. See [`design/transport/`](transport/overview.md).

## Context Window Management

See [`design/context-management.md`](context-management.md) — token counting, three-layer compaction pipeline (clear tool results → summarize → truncate), model registry, usage tracking.

## AI Steering Rules `[confirmed]`

Rules stored as PostgreSQL rows. Injected into system prompts at invocation time. Scoped on two independent axes — profile and channel — so a rule can apply globally, per-profile, per-channel, or to a specific profile-on-channel combination. Managed by the `DefaultPromptSource` which loads the profile's base prompt and layers applicable rules on top.

Stage 1 evolution edits these rows. Stage 5 signal pipeline auto-proposes new rules from conversation signals.

```sql
steering_rules (
  id                UUID v7 PK,
  rule              TEXT NOT NULL,
  category          TEXT NOT NULL,            -- 'safety' | 'style' | 'domain' | 'memory'
  active            BOOLEAN NOT NULL,
  source            TEXT NOT NULL,            -- 'manual' | 'correction' | 'signal_pipeline' | 'evolution'
  priority          INT NOT NULL,             -- ordering in system prompt
  observation_count INT NOT NULL,             -- rule graduation (2+ = promoted)
  profile_id        UUID FK → profiles,       -- nullable: null = applies to all profiles
  channel_type      TEXT,                     -- nullable: null = applies to all channels
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Query at prompt assembly: `(profile_id = $p OR profile_id IS NULL) AND (channel_type IN $activeChannels OR channel_type IS NULL) AND active = true`. Cross-channel conversations union rules from all active channels.

All behavioral instructions — global, profile-scoped, and channel-scoped — live in this one table. Default channel rules (e.g., "avoid tables on Telegram", "prefer concise replies") are seeded when a channel is configured, same pattern as profile seeding. Adapters own only mechanical output rendering (`renderOutput`), not behavioral guidance. See [transport/adapters.md](transport/adapters.md) → Response Rendering.

### Observation lineage `[confirmed]`

Channel lineage is derived from the relational graph: `conversationId → channel_sessions → channels.type`. No denormalized column — the Observer's `load-active-channel-types` step calls `transportStore.getActiveChannelTypes(conversationId)` at extraction time.

The Observer threads the active channel set into the extraction prompt; the LLM decides per correction whether it's channel-specific ("don't use tables" → `channelType: "telegram"`) or general ("be more concise" → `channelType: null`). The extraction Zod schema carries `channelType` on the `new` discriminated-union variant only — `reinforce` / `contradiction` inherit scope from the matched id. Hallucinated channel values outside the active set are coerced back to `null` with a warning before reaching the DB. `consolidateRules` excludes channel-scoped rows from merge candidates because `replaceRules` only emits the merged row as global; same-channel-scope merging is a future enhancement once `replaceRules` preserves `channel_type`.

Future: if per-observation precision matters (rule graduated from mixed channels), introduce a `steering_rule_observations` table (`rule_id`, `conversation_id`, `channel_type`, `created_at`). Earns its keep when the rule count exceeds what eyeballing can handle.

## Crash Recovery `[confirmed]`

Inngest durable steps checkpoint between boundaries; on retry, cached steps replay from state without re-executing their bodies. The streaming section of `handle-message` is intentionally non-durable (you can't stream out of `step.run`) and re-executes on every retry — this is a deliberate tradeoff.

See [crash-recovery.md](crash-recovery.md) for the full durability map of `handle-message`, the per-tool re-execution table, the streaming dedup story, and the test contract.

## Activity-Based Timeouts `[proposed]`

From NanoClaw. Timeout resets on every tool call or partial response. Only kill truly stuck agents, not long-running ones that are making progress.

