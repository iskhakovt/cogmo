# Agents

## The Agentic Loop `[confirmed]`

No framework. Raw SDK while loop + tool dispatch. Implemented in `src/agent/loop.ts`.

The loop takes a system prompt, message history, tools, and an LLM provider. It calls the LLM, executes any tool calls, appends results, and repeats until the LLM stops without calling a tool. In `runStreamingAgentLoop` — the variant every production caller uses — a reply that stops at `max_tokens` is marked as cut off, and the call the cap interrupted is answered rather than run; see [agent-resilience.md](agent-resilience.md) → Class C. The non-streaming `runAgentLoop` has no production caller and no Class C classifier: it gates on content alone, so it runs every tool call it receives, capped or not. Returns the final text, full message history (defensive copy), `newMessages` (only the messages produced this invocation — intermediate tool_use/tool_result turns + final assistant), and usage stats. The orchestrator persists all `newMessages` with full `ContentBlock[]` content — tool invocations are available in the conversation history for replay, compaction, and Stage 1 correction extraction.

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

Validation failure → a rejection (below) carrying the error details → LLM can retry with corrected input.

### Tool Definition

```typescript
// Universal tool spec — stored in registry, execution-environment agnostic
interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: ToolHandler;
}

// Typed helper for in-process TypeScript tools (Zod convenience)
function defineTool<T>(opts: {
  name: string;
  description: string;
  schema: ZodSchema<T>;
  handler: (input: T, capabilities: Service, ctx?: ToolCallContext) => Promise<ToolOutcome>;
}): ToolSpec;
```

### Handler Signature `[confirmed]`

```typescript
type ToolHandler = (
  input: Record<string, unknown>,   // LLM-provided, validated against inputSchema
  capabilities: Service,            // orchestrator-provided, pre-scoped dispatch
  ctx?: ToolCallContext,            // per-call facts: the idempotency key
) => Promise<ToolOutcome>;

type ToolOutcome = Result<string, ToolRejection>;   // neverthrow
interface ToolRejection { readonly message: string } // LLM-facing
```

**Data in** (from LLM) and **capabilities** (from orchestrator), plus an optional per-call context. Capabilities are pre-scoped, so tools don't need per-request metadata like userId. Files and attachments are accessed through capabilities (`readAttachment(id)`), not passed as input.

**Outcome.** `ok(content)` becomes the `tool_result` content. An expected failure — arguments the tool can't honour, an unconfigured capability, a domain error from the service, an upstream refusal — is `reject(message)`: the loop answers it with `{ content: "Error: <message>", isError: true }`. The flag is what the rest of the turn reads: Class D counts a rejected call as no progress, the volume-cluster summary counts it as a failure, and delivery (the Telegram stream handle's mid-stream image and document sends) skips it. A throw is a bug; the loop still answers with an `is_error` tool_result, so the turn carries on, and logs it at error level. A durable tool's rejection is its `tool-iter<N>-<P>` step's result, not a failed step — see [crash-recovery.md](crash-recovery.md#per-tool-durability).

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

### Turn Authority `[proposed]`

What a turn's tools may do depends on who started the turn. A user turn acts with the user's authority. A scheduled fire or a pipeline stage runs a prompt saved earlier, often written by the model, with nobody watching. It may not extend itself (schedule, start pipelines), launch unattended work (delegate coding, register skills) or write standing instructions (rules, core memory). Without that limit, injected text in a fire's prompt, or in a page the fire reads, can schedule a recurring prompt that delegates coding and schedules again.

**Sources.** `TurnSource` is the value set of the `inbound_message_source` pgEnum: `user`, `scheduled`, `pipeline`. A new value is a compile error in every exhaustive match over it until it has a policy. Nothing else starts a turn: a sub-agent is a tool-free call inside one, and a skill invoked as a tool acts through its turn's `Service`.

**Where the source comes from.** Durable state, never message content. `handle-message` computes `turnAuthorityOf(rows)` over the rows `load-inbound` memoized, each of which carries its `source`. The pipeline stage runner passes `pipeline`: it runs only stage turns, and its `persist-stage-prompt` writes the inbound as `source='pipeline'`. The turn's authority is `TurnAuthority = { kind: "turn"; source: TurnSource }`.

**Policy.** Every `ToolSpec` declares `requires: "any_turn" | "user_turn"`. The field is required, where `durable` is optional, so a tool can't ship without a decision; `defineTool` and the MCP, skill and sub-agent builders set it. `ToolRegistry.register` throws on a `user_turn` spec that isn't `durable`, so every verdict that can refuse is memoized. `authorize(authority, spec)` in `src/agent/turn-authority.ts` applies it: a user turn may call every tool, a scheduled or pipeline turn only `any_turn` ones. A stage's allowlist narrows its set further ([pipelines.md](pipelines.md#safety-proposed)).

| Tool | Requires | Scheduled and pipeline turns | Why |
|-|-|-|-|
| `schedule_task` | `user_turn` | refused | The recursion guard (below). |
| `remove_task` | `user_turn` | refused | A fire's prompt must not cancel the user's other tasks; a fire ending its own task is an open question. |
| `delegate_coding` | `user_turn` | refused | It starts a sandboxed run and a draft PR, unattended when the profile auto-approves plans. Pipelines slice 4 adds a stage-scoped grant. |
| `rule_set`, `rule_remove` | `user_turn` | refused | The non-user refusal [evolution.md](evolution.md#tools) specifies; the tools are not built yet. |
| `core_memory_update` | `user_turn` | refused | Core memory renders into every system prompt, so a write is a standing instruction. |
| `register_skill` | `user_turn` | refused | It deploys code, and register's risk tier ([skills.md → Risk tiers without a human](skills.md#risk-tiers-without-a-human)) can put the skill live with no human tap. |
| `draft_skill` | `user_turn` | refused | It starts a skill draft ([skills.md → Authoring pipeline](skills.md#authoring-pipeline-proposed)), and an edit that keeps the live spec skips the spec card, so its coding, review and deploy can run with no human tap. |
| `define_pipeline`, `activate_pipeline`, `start_pipeline` | `user_turn` | refused | Activation's preview/confirm gate needs the user; a definition's cron trigger is how a pipeline runs unattended. |
| `memory_retain` | `any_turn` | allowed | Recording what it found is the point of many tasks. Tagging the staged row with the turn source, so the Observer can weigh a fact no user stated, is designed in turn-authority slice 3 (`todo.md`). |
| `web_search`, `web_answer`, `fetch_url` | `any_turn` | allowed | A digest needs them; `fetch_url`'s destination check applies in every turn, and the refusals above limit what returned content can trigger. |
| Skill tools (one per deployed skill) | `any_turn` | allowed | A deployed skill's effects were classified, and approved where its risk tier requires, at deploy ([skills.md](skills.md#risk-tiering--auto-apply-confirmed)). |
| `mcp__*` | `any_turn` | allowed | The user approves each server per profile; whether a server can opt out of non-user turns is an open question. |
| `write_file`, `edit_file`, `send_document`, `generate_image` | `any_turn` | allowed | A task's ordinary output: workspace files and deliveries to the user's own channels. The task cap and cadence bound what they cost. |
| `subagent__*` | `any_turn` | allowed | Tool-free, text out. |
| `memory_recall`, `memory_reflect`, `core_memory_read`, `read_file`, `list_files`, `list_tasks`, `list_pipelines`, `get_current_time` | `any_turn` | allowed | Reads. |

**Frozen with the tool table.** `requires` is part of `FrozenToolSpecSchema`, so a run dispatches on the declarations its `freeze-turn-inputs` stored. A table frozen before the field parses with `requires: "any_turn"`: a build with no policy allowed every tool, and the run keeps the authority it started with. The frozen table is in the configuration digest, so the deploy that adds the field and the one that first declares `user_turn` each open one `configuration` epoch in every conversation at its next turn ([prompt-caching.md](prompt-caching.md#system-prompt-snapshot-confirmed)).

**Enforced in one place: tool dispatch.** The loop takes `authority: TurnAuthority` as a required parameter beside `turnKey`. `runOne`'s handler thunk, the body of the durable `tool-iter<N>-<P>` step, calls `authorize` first and on a refusal returns `reject(message)` without calling the handler, so the refusal memoizes as the step's result and a replay returns it. The verdict is `{ kind: "allowed" } | { kind: "refused"; reason: "needs_user_turn" }`, matched exhaustively. The plan-then-execute refusal evolution.md specifies for the rule tools is a separate check in the same thunk, since it also reads the turn's memoized iterations.

Handlers never read the source, and `ToolCallContext` doesn't carry it: the context is absent for non-durable tools and outside a retrying context. The one per-source behaviour inside a call, the turn source on a staged memory (turn-authority slice 3), is bound into the `Service` by `buildTurnService`, which then takes `TurnAuthority | { kind: "no_turn" }`. `no_turn` is a skill run outside any turn, cron-fired or from the CLI (`resolveSkillRunAs`): it stages memories with no turn source. The operator configured the run, no model chose it, its manifest's classified effects bound what it does, and its `ctx` has no scheduling, coding or rules methods.

A refused tool stays in the turn's tool table, so chat and fire turns share one cached prefix ([prompt-caching.md](prompt-caching.md#one-prefix-per-conversation-proposed)); the turn context names the refused tools.

**What the model is told.**

- **The refusal**, an `is_error` tool_result: `Error: schedule_task isn't available in a scheduled turn: it needs a message from the user. Nothing was scheduled. Say in your reply what you would have done; the user can ask for it in their next message.` Class D counts it as no progress, and repeated attempts meet the volume-cluster nudge.
- **The turn context** of a non-user turn, on the user message rather than in the system prompt, carries one more line: `Turn source: scheduled task. The user didn't send this message and isn't present: it is a task's saved prompt. Refused in this turn: schedule_task, remove_task, delegate_coding, core_memory_update. Memories you save are marked as saved by a scheduled task.` A stage turn reads `pipeline stage` and `a pipeline stage's instructions`. The refused list is the turn's frozen tool table filtered through `authorize`, so it names only tools the turn offers, and both inputs are step results. It is stored as `TurnContextSchema.authority` ([prompt-caching.md](prompt-caching.md#data-model)).
- **The standing guidance**, `TURN_CONTEXT_GUIDANCE`, gains a sentence: when the turn context names a source other than the user, nobody is replying turn by turn, so do the task and report what was done and what was refused.

**A mixed batch fails today.** The only mixed batch `handle-message` can load is user plus scheduled: a fire reuses an engaged conversation, so it can land while a user message waits out its debounce. `routingKindOf` throws on it in the bare body, before the loop, so the run fails after its retries and `onFailure` reports the turn failed and may open a cooldown. `turnAuthorityOf` still gives such a batch the least authority present, as defence in depth and as the rule for when the mixed-batch slice admits it: the model reads the batch as one message and can't tell which row asked for what, so a user row must not lend its authority to a fire's text.

**Recursion guard.** No fire can create another: only user turns, the setup wizard and the CLI change the task set or a pipeline's triggers, and no turn without a user can add a task or start a pipeline. Unattended turns per user are then bounded by the task cap (`DEFAULT_SCHEDULED_TASK_CAP`, 200) times the fastest cadence (`MIN_CRON_INTERVAL_SECONDS`, one fire a minute), plus the active pipeline cron triggers times each definition's run quota ([pipelines.md](pipelines.md#safety-proposed)); a trigger is created at activation, which needs the user.

**Failure modes.** The verdict is a pure function of the memoized inbound rows and the frozen declaration, so the policy adds no state.

| Case | What happens | Why it is safe, or the residual |
|-|-|-|
| Crash inside a tool step before Inngest records it | The retry re-runs the thunk and gets the same verdict; an allowed call reaches the handler with its usual idempotency key | As for any durable tool ([crash-recovery.md](crash-recovery.md#per-tool-durability)) |
| A run in flight across a deploy that changes declarations | Memoized steps replay their result; steps not yet run get the verdict of the table the run froze, `any_turn` for one frozen before the field | A memoized result and a frozen table are the contract with runs in flight. Residual: a fire in flight across the deploy that first declares `user_turn` can still schedule; `list_tasks` shows the task |
| A re-delivered turn (a new run, empty step cache) after such a deploy | It freezes a fresh table, so its calls meet the current declarations; a batch that has grown into a mixed one throws, as above | Residual: a call the first delivery committed stays while the re-delivery may refuse it and say nothing was done; `list_tasks` shows what exists |
| Two runs on one conversation | The conversation concurrency key serializes chat and stage turns; each run's authority comes from its own batch | Nothing shared |
| The model repeats a refused call | Each is refused; the volume-cluster nudge follows past the tool's invocation budget | The loop stays bounded |
| `inbound_message_source` gains a value | Compile error in `turnAuthorityOf`, `authorize` and the turn-context renderer | Nothing reaches dispatch without a policy |

A refusal costs one step record and one more loop iteration; no handler runs. Implementation slices are in `todo.md` → Scheduling.

**Open questions.**

- **A fire ending its own task** ("check every hour until it's in stock"). It needs the firing task's id as durable turn state, which the turn doesn't carry today; `remove_task` stays `user_turn` until then.
- **MCP servers in non-user turns.** Profile approval is the only gate today; a per-server opt-out would let the user keep a server with irreversible writes out of fires.
- **The creation side.** A fire's task is created in a user turn, possibly after that turn read an injected page. The plan-then-execute refusal evolution.md gives the rule tools would apply to `schedule_task` as well; this section bounds what a fire can do, not whether it gets created.

## Routing: Agents-as-Tools `[confirmed]`

A **sub-agent** is a specialist model the orchestrator can delegate a subtask to, exposed as a tool. It's the answer to "this model is great at a feature but can't run tools": the orchestrator holds the tools, the specialist runs tool-free and returns text. Claude's native tool selection handles routing — no router agent.

**Data model.** `sub_agents` (owned here; schema in `src/agent/store/schema/sub-agents.ts`) is a per-user catalog — a thin binding over a model already routable via `model_providers`:

- `name` → surfaced as a tool `subagent__<name>` (namespaced like `mcp__`, so it can't collide with a built-in and a profile can opt in with a `subagent__*` glob).
- `description` → the routing signal the orchestrator reads to decide *when* to delegate. Required.
- `system_prompt` → standing persona/format/policy for the specialist. **Nullable**: null = pure model-as-tool (the per-call task carries all instruction); set = a persona reused across calls. The two readers differ — `description` is read by the orchestrator, `system_prompt` by the specialist.
- `model` → resolved via the `LlmProviderResolver`, so a sub-agent can target any provider (including one the main turn doesn't use). Validated to exist in `model_providers` at write time but **not** `user_selectable`-gated — like `profiles.summarization_model`, it's an internal-use model.

**No profile↔sub-agent join table.** Availability is per-profile through the existing `profiles.tool_set` globs — the same mechanism that gates built-ins, skills, and MCP tools. Definitions are global/reusable; a profile opts in by listing `subagent__<name>` (or `subagent__*`). `tool_set` holds plain strings with no FK, so deleting a sub-agent just removes the tool next turn.

**Runtime (v0 — text-in/text-out).** `buildSubAgentTools` (`src/agent/subagent/sub-agent-tool-builder.ts`) turns each row into a `ToolSpec` whose handler resolves the model and runs a single `provider.chat({ system, messages, /* no tools */ })`. The specialist gets no `Service` and no tools — the orchestrator curates context in via `{ task, context }` and acts on the text out. Tool metadata: `parallelSafe` (independent LLM call), `sideEffectful: false` (keeps the Class-D loop gate honest), `invocationBudget: 3` (caps runaway delegation), `durable: true` (a `handle-message` retry replays the cached result instead of re-billing). `handle-message` loads the rows each turn and folds the specs into the built-ins set fed to `composeTurnTools`. Managed via `cogmo subagent add/list/remove`.

This satisfies **Security: Orchestrator Holds Secrets** trivially — the specialist never receives a `Service` or a key; the orchestrator's process makes the call.

**Deferred.** Nested `runAgentLoop()` sub-agents with their own toolset (re-opens secrets/ACL + nested durability) and richer CRUD surfaces (wizard step, web UI, Telegram `/subagent`).

## Security: Orchestrator Holds Secrets `[confirmed]`

Sub-agents never see API keys — the orchestrator makes all external calls. In v0 a sub-agent runs tool-free and returns only text (see Routing: Agents-as-Tools above). The deferred nested-loop variant would instead return tool calls for the orchestrator to validate and execute — still never holding a key itself.

## Security: `fetch_url` Destinations `[confirmed]`

`fetch_url` runs in the server process, so a URL taken from a page or a message would otherwise reach whatever the deployment can: Hindsight, Inngest, cloud metadata. Every hop is checked before it is connected to, and must be `http`/`https`. An IP literal is judged as written and a name by every address it resolves to; any non-public one refuses the call (`isBlockedAddress` in `src/util/blocked-address.ts`, shared with `ctx.http`). Redirects are followed by hand, up to 10. A refusal names the host but not the address, which goes to the log. Neither a refusal nor a host that does not resolve falls back to Tavily, which would hand the full URL to a third party. A refusal is final. A lookup is retried only while the resolver reports itself unavailable (`EAI_AGAIN`, or no answer within 10s). A later hop's lookup cut off by the attempt's 15s budget is retried as an attempt timeout and, if that keeps happening, ends `transient`, so Tavily gets the original, public URL. The residual is the DNS-rebinding gap described under `ctx.http.request` in [skills.md](skills.md).

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
  status            steering_rule_status NOT NULL, -- 'live' | 'learning' | 'disabled' | 'retired'; evolution.md → Explicit Instructions → Lifecycle
  source            steering_rule_source NOT NULL, -- 'manual' | 'seed' | 'instruction' | 'correction' | 'evolution'; decides the `# Rules` section
  priority          INT NOT NULL,             -- ordering within a section, after scope; ties broken by id
  observation_count INT NOT NULL,             -- observations behind the rule; a learning rule's second graduates it
  profile_id        UUID FK → profiles,       -- nullable: null = applies to all profiles
  channel_type      TEXT,                     -- nullable: null = applies to all channels
  retracted_at      TIMESTAMPTZ,              -- nullable: when a retired row was retired; set exactly when status = 'retired'
  retired_reason    steering_rule_retired_reason, -- nullable: 'contradicted' | 'superseded' | 'removed_by_user' | 'unknown'; set exactly when status = 'retired'
  user_id           UUID FK → users ON DELETE CASCADE, -- nullable: null = every user; set on every instruction row
  quote             TEXT,                     -- nullable: the user's words; set on every instruction row
  contradicted_in_turn_id UUID FK → turn_observations ON DELETE SET NULL, -- nullable: null = never contradicted while learning; the turn that reset or retired it; only on a learning or retired row
  contradicted_in_conversation_id UUID FK → conversations ON DELETE SET NULL, -- nullable: NULL on every row written after the migration, read by nothing; kept for rollback until a later migration drops it
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- chk_steering_rules_lifecycle, uq_steering_rules_instruction: evolution.md → Explicit Instructions → Data Model
```

Query at prompt assembly: `(profile_id = $p OR profile_id IS NULL) AND (user_id = $u OR user_id IS NULL) AND status = 'live'`, every channel's rules included, and no user's rules where the turn's scope has no core memory. `# Rules` renders the result in sections by `source`, and within a section by scope, then priority, then id, newest first ([evolution.md](evolution.md#precedence-confirmed) → Precedence), each channel-scoped rule labelled with its channel ("On telegram: …"); the turn context names the channels a reply goes to, so sessions coming and going leave the system prompt as it is ([prompt-caching.md](prompt-caching.md#system-prompt-snapshot-confirmed) → System Prompt Snapshot). The `id` tie-breaker keeps the rendered rules byte-stable: priorities are shared, and an in-place update moves a row in the heap.

All behavioral instructions — global, profile-scoped, and channel-scoped — live in this one table. Default channel rules (e.g., "avoid tables on Telegram", "prefer concise replies") are seeded as `seed` rows when a channel is configured, same pattern as profile seeding. Adapters own only mechanical output rendering (`renderOutput`), not behavioral guidance. See [transport/adapters.md](transport/adapters.md) → Response Rendering.

### Observation lineage `[confirmed]`

Channel lineage is derived from the relational graph: `conversationId → channel_sessions → channels.type`. No denormalized column — the Observer's `load-active-channel-types` step calls `transportStore.getActiveChannelTypes(conversationId)` at extraction time.

The Observer threads the active channel set into the extraction prompt; the LLM decides per correction whether it's channel-specific ("don't use tables" → `channelType: "telegram"`) or general ("be more concise" → `channelType: null`). The extraction Zod schema carries `channelType` on the `new` discriminated-union variant only — `reinforce` / `contradiction` inherit scope from the matched rule. The prompt lists existing rules under ordinal labels (`R1`…`Rn`), not ids: the model echoes a label in `matchedExistingRuleId`, the extractor maps it back to the rule's id, and a reinforcement or contradiction whose label names no listed rule is skipped with a warning. Labels follow priority, then rule text, with the id only breaking an exact tie, so the prompt stays byte-stable across runs; a short label is also easy to copy exactly. `consolidateRules` labels each scope's rules the same way in `originalIds`. A `new` correction that omits `channelType` or `matchedExistingRuleId` parses as `null` for both: where decoding isn't constrained to the schema, a model can drop a field whose only meaning is "absent", repair retry included. The JSON Schema the model receives still lists both as required. Hallucinated channel values outside the active set are coerced back to `null` with a warning before reaching the DB. `consolidateRules` merges within one channel scope at a time: it groups active rules by `channel_type`, and `replaceRules` writes each merged row with its scope's `channelType`.

Future: if per-observation precision matters (rule graduated from mixed channels), introduce a `steering_rule_observations` table (`rule_id`, `conversation_id`, `channel_type`, `created_at`). Earns its keep when the rule count exceeds what eyeballing can handle.

## Crash Recovery `[confirmed]`

Inngest re-invokes the whole function at every step boundary (on success, not just retry); cached steps replay from state without re-executing their bodies. In `handle-message`, every expensive or user-visible unit inside the streaming section is itself a durable step — each LLM iteration (`llm-iter<N>`, which streams tokens live from inside its body and is suppressed on replay), each durable tool handler (`tool-iter<N>-<P>`), the degraded-reply off-ramp, and auto-recall. Only cheap deterministic glue re-executes per invocation.

See [crash-recovery.md](crash-recovery.md) for the full durability map of `handle-message`, the tool durability policy, the streaming dedup story, and the test contract.

## Activity-Based Timeouts `[proposed]`

From NanoClaw. Timeout resets on every tool call or partial response. Only kill truly stuck agents, not long-running ones that are making progress.

