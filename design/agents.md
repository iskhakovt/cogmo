# Agents

## The Agentic Loop `[confirmed]`

No framework. Raw SDK while loop + tool dispatch. Implemented in `src/agent/loop.ts`.

The loop takes a system prompt, message history, tools, and an LLM provider. It calls the LLM, executes any tool calls, appends results, and repeats until the LLM returns `end_turn` or `max_tokens`. Returns the final text, full message history (defensive copy), and usage stats.

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

## Routing: Agents-as-Tools `[proposed]`

Define each sub-agent as a tool. Claude's native tool selection handles routing. No router agent needed. Sub-agents are just nested `runAgentLoop()` calls with their own system prompts and tool sets.

## Security: Orchestrator Holds Secrets `[confirmed]`

Sub-agents never see API keys. Orchestrator makes all external calls. Sub-agents return tool calls and text; orchestrator validates and executes.

## Messaging Architecture

How messages flow from platform to agent and back. See [`design/transport/`](transport/overview.md).

## Context Window Management

See [`design/context-management.md`](context-management.md) — token counting, three-layer compaction pipeline (clear tool results → summarize → truncate), model registry, usage tracking.

## AI Steering Rules `[confirmed]`

Rules stored as PostgreSQL rows. Injected into system prompts at invocation time. Can be global or scoped to a profile. Managed by the `DefaultPromptSource` which loads the profile's base prompt and layers applicable rules on top.

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
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

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

