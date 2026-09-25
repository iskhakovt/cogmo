# Prompt Caching `[proposed]`

How Cogmo keeps the prompt prefix byte-stable across agent-loop iterations and across turns, and how each LLM adapter turns that stability into provider cache hits. Two halves:

- **Provider-agnostic** — a frozen system prompt, an append-only transcript, per-turn state rendered from durable data, and usage accounting that reports total prompt size. Every provider benefits: Anthropic reads what its breakpoints wrote, and OpenAI, xAI and most OpenAI-compatible servers cache prefixes automatically.
- **Per-adapter** — a provider-neutral cache intent on `ChatParams` that each adapter maps to its own wire format (Anthropic breakpoints, OpenRouter pass-through, OpenAI `prompt_cache_key`, xAI `x-grok-conv-id`).

Related: [context-management.md](context-management.md) (compaction invalidates the prefix by design; the skip-counting fast path depends on usage accounting), [providers.md](providers.md) (adapter dispatch, `llm_providers.attrs`), [memory.md](memory.md) (auto-recall), [voice.md](voice.md) (voice-mode hint), [crash-recovery.md](crash-recovery.md) (what re-runs on a replay).

## Problem `[confirmed]`

Verified against the code on 2026-09-23.

**The transcript is never cached.** `buildCreateParams` (`src/llm/anthropic.ts`) marks the last tool and the system block with `cache_control`, and nothing in `messages`. Anthropic renders `tools` → `system` → `messages`, so every message, `tool_result` and thinking block is full-rate input on every request, and a turn re-sends the transcript once per iteration — a five-tool-call turn pays for it six times.

**The system prompt changes between turns.** It is assembled once per turn inside the `assemble-prompt` step, so it is stable *within* a turn; across turns, these inputs change it:

| Input | Where | How often it changes |
|-|-|-|
| `Current time: …` at minute resolution | `DefaultPromptSource.assemble` (`src/agent/prompt.ts`) | Every turn that starts in a new minute |
| `# Recalled Context` | appended to the system prompt in `handle-message.ts` (`fullPrompt`) | Nearly every turn: the default `heuristic` recall mode skips only messages under four characters, greetings, acknowledgements and continuation phrases (`src/agent/recall-gate.ts`) |
| `# Voice mode` hint | `prompt.ts` | When a conversation alternates voice and text turns |
| `# User` (core memory blocks) | `getUserContext` in `src/index.ts` | When the agent edits core memory |
| `# Rules`, `# Tools`, `# Capabilities` | `prompt.ts` | When steering rules, the tool catalog or service guidance change |

The first three are per-turn state; the rest are configuration. Because the transcript renders after the system block, a changed system block invalidates every cached message behind it — so moving the clock alone leaves the transcript uncacheable across turns, because recall changes it on nearly every turn anyway.

**It is not Anthropic-specific.** OpenAI, xAI and OpenRouter's non-Claude routes cache the longest matching prefix automatically. With the clock and recall at the end of the system message, their cached prefix also stops where the transcript starts.

**It breaks preserved thinking.** On Claude Opus 5.5 and Fable 5.1, a thinking block's signature binds the top-level `system` prompt, the tool set and every earlier message; replaying the block after any of them changed is a 400 for accounts created on or after 2026-08-31 (older accounts opt in). A system prompt that changes every turn is that edit, on every turn after the first.

**Caching the transcript would break compaction's fast path.** Anthropic's `usage.input_tokens` counts only the tokens after the last breakpoint. The loop sums it across iterations and persists it as `lastMessageInputTokens`, which `shouldSkipCounting` (`src/agent/context.ts`) reads to decide whether compaction Strategies 1–3 run. With the transcript cached, the value collapses to the uncached tail, the fast path skips the budget strategies, and the conversation grows until the API rejects it. The adapters already disagree: the OpenAI-compatible adapter reports `prompt_tokens`, which includes cached tokens.

## Research Base `[research]`

Surveyed September 2026.

| Finding | Evidence |
|-|-|
| Keep the system prompt byte-stable; put dynamic data in the next user message. "Make the system prompt a byte-stable constant and move dynamic data into the first `user` message after your cache breakpoint." | Anthropic cache-diagnostics docs |
| Claude Code puts the time and file changes in a `system-reminder` tag in the next user message or tool result "which helps preserve the cache". | Anthropic, "Prompt caching is everything" (Apr 2026) |
| "A common mistake is including a timestamp — especially one precise to the second — at the beginning of the system prompt." Make context append-only; serialize deterministically. KV-cache hit rate is "the single most important metric for a production-stage AI agent". | Manus, "Context Engineering for AI Agents" (Jul 2025) |
| Mid-conversation `role: "system"` messages keep the prefix intact, but are not available on Claude Sonnet 5. User-message text is the only carrier that works on every model we route to. | Anthropic mid-conversation system messages docs |
| Top-level `cache_control` ("automatic caching") places the breakpoint on the last cacheable block and moves it forward as the conversation grows; accepts `ttl: "1h"`; uses one of the four breakpoint slots; available on every platform except legacy Bedrock. | Anthropic prompt-caching docs |
| A breakpoint walks back at most 20 positions looking for a prior write; a run of `tool_use` blocks and a run of `tool_result` blocks each count as one position. | Anthropic prompt-caching docs |
| Longer TTLs must precede shorter ones in a request. Writes cost 1.25× (5 min) or 2× (1 h); reads 0.1×, **0.05× on Opus 5.5**. A read refreshes the entry at no cost. The TTL runs from the start of the request. | Anthropic prompt-caching docs |
| Minimum cacheable prefix: 512 tokens on Opus 5.5 and Opus 5, 1,024 on Sonnet 5, 4,096 on Haiku 4.5. It counts the whole prefix, tools and system included. | Anthropic prompt-caching docs |
| Use the 1-hour TTL "when storing a long chat conversation where the user may not respond within 5 minutes." | Anthropic prompt-caching docs |
| Anthropic `input_tokens` is only the tokens after the last breakpoint; total = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. | Anthropic prompt-caching docs |
| `gen_ai.usage.input_tokens` "SHOULD include all types of input tokens, including cached tokens"; the Anthropic mapping sums the three fields. `cache_creation` was renamed `cache_write` (Development stability). | OpenTelemetry GenAI semantic conventions |
| OpenAI caches automatically from 1,024 tokens. `prompt_cache_key` routes related requests to the same cache on models before GPT-5.6 and separates cache accounting on 5.6+. Usage reports `cached_tokens` inside a total that includes them. | OpenAI prompt-caching guide |
| xAI caches automatically; `x-grok-conv-id` "routes requests with the same conversation ID to the same server. Since cache entries are stored per-server, this maximizes your cache hit rate." | xAI prompt-caching docs |
| OpenRouter passes Anthropic `cache_control` through (per-block, and top-level for the Anthropic, Vertex, Azure and Bedrock providers); `session_id` / `x-session-id` pins sticky routing; usage reports `cached_tokens` and `cache_write_tokens`. | OpenRouter prompt-caching docs |

## Principles `[proposed]`

1. **The system prompt is a function of configuration only** — identity, core memory, tools, capabilities, steering rules. Nothing per-turn goes in it.
2. **The transcript is append-only.** What the model saw on one request, it sees again byte-identical on every later request, until compaction deliberately rewrites it.
3. **Per-turn state belongs to its turn.** It renders as part of that turn's user message, from durable data, identically every time the message is sent.
4. **Cache intent is provider-neutral; wire format is the adapter's.** Domain code says "this transcript will be re-sent"; adapters decide what that means on the wire.
5. **Usage reports total prompt size.** Cache reads and writes are subsets of `inputTokens`, never in addition to it.

## Turn Context `[proposed]`

The per-turn state that today sits in the system prompt moves into a **turn context block** on each user-turn message.

### Contents

| Field | Source | Stored |
|-|-|-|
| Time | `messages.created_at` of the user row, formatted in the configured user timezone | No — derived |
| Recalled memories | the `auto-recall` step, minus memories already rendered in the loaded window | Yes |
| Voice mode | the per-turn voice decision (`resolveVoiceMode`) | Yes — the settings it derives from can change later |

Every user message carries its own time, so the model also sees a timeline of the conversation — useful for relative references ("what I asked you yesterday"). A user message with no stored context renders the time alone. Rows written before this ships render the same way, so the deploy itself is one full re-write for every live conversation.

- **The time is when the turn was handled**, not when the user sent it: `created_at` is set by `create-user-message`, after debounce and transcription. That is what "current time" means for the reply; after an outage it trails the send time.
- **The timezone is pinned per deployment.** It comes from process config, so changing it re-renders every past turn once.
- **The compaction summary carries no time.** `loadTurnHistory` emits it as a synthetic user message with no row behind it.

### Rendering

One pure function, `renderTurnContext`, renders a leading text block on the user message, ahead of the user's own content — matching Anthropic's long-context guidance of data first, question last:

```
<turn_context>
Current time: Friday, September 25, 2026, 09:14 (Europe/London)

<recalled_memories>
…
</recalled_memories>

This reply will be spoken aloud. Keep it short and natural — …
</turn_context>
```

The same function renders every turn:

- **Past turns** — inside `load-turn-history`, from the loaded rows (`created_at`) and their stored context.
- **The current turn** — from the same row's `created_at`, the memoized `auto-recall` result, and the memoized voice decision.

Identical inputs through one function make the current turn's bytes and the next turn's reload identical by construction; a unit test pins that equality.

The block ends with a blank line. The OpenAI-compatible adapter sends a text-only user message as its text blocks joined with no separator, so the separation has to be part of the rendered text.

Every input to the block comes from a step result or the event payload. Voice-mode resolution reads the profile, the conversation and the delivery handle, none of them durable, so its result is frozen in a step; today `assemble-prompt` freezes it implicitly by baking the hint into the prompt text.

Recalled memories are data, not instructions, and move from the system prompt — the operator-authority slot — into user content. That also narrows an injection surface: stored memories can carry text that originated in web pages or tool output.

### Deduplication

Auto-recall returns up to ~2,000 tokens per turn. Rendering every result on every turn would grow the transcript by that much each turn. At recall time, the turn keeps only memories whose content does not already appear in a turn context in the loaded window (after the latest compaction summary). What is stored is exactly what is rendered, so the decision replays deterministically. After a summary moves the window forward, a memory can be recalled again; that is intended.

### Data model

```
turn_contexts
  id           UUID PRIMARY KEY DEFAULT uuidv7()
  message_id   UUID NOT NULL UNIQUE REFERENCES messages(id)  -- the user-turn row
  context      JSONB NOT NULL                                -- TurnContextSchema
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
```

`TurnContextSchema` is `{ recalledMemories: string[], voiceMode: boolean }`. A row exists only when a turn has recalled memories or voice mode on; absence renders as time-only. Owned by `agent/store/`.

A side table rather than a column on `messages`: the row is written after the user row exists (see below), so a column would mean updating the user row. It also keeps `messages.content` as "what the user said", which the web UI (through `Transport`) and the Observer read. An Observer extracting facts from the user row must not re-extract the memories recall injected.

**Written in `persist-new-messages`**, in the same transaction as the turn's assistant and tool rows, so a turn's context and its output commit together. The `create-user-message` step returns the new row's id for this. The `turn_contexts` write is idempotent under a retry-after-commit via `UNIQUE (message_id)` and `ON CONFLICT DO UPDATE` with a no-op set (see `.claude/rules/inngest.md`). The step's other write, `insertMessages`, carries no such key; that is outside this design.

**A turn that fails before persisting** leaves its user row without a context row; the next turn renders that message time-only. No assistant output was persisted for it, so no thinking block was bound to the richer version.

### What stays in the system prompt

Identity, `# User` (core memory), `# Tools`, `# Capabilities`, `# Rules`. Each changes only on a configuration event, and each change still invalidates the transcript behind it, and — on Opus 5.5 / Fable 5.1 — invalidates earlier thinking blocks. That is accepted for now and tracked with the other preserved-thinking edits in `todo.md`; see [Open questions](#open-questions).

### Alternatives considered

| Option | Why not |
|-|-|
| Time as a trailing block on the latest message only, not persisted | The next turn removes it from an earlier message: a history edit that misses the cache from that message on and invalidates later thinking blocks. |
| Date-only in the system prompt | Invalidates daily instead of per minute, loses time of day, and leaves recall in place. |
| Mid-conversation `role: "system"` message | Not available on Sonnet 5, so every call site needs a capability gate and a fallback; a clock and recalled memories don't need operator authority. |
| Recall rendered ephemerally after a per-turn anchor breakpoint, dropped next turn | No schema change, and a 1-hour anchor keeps the prefix before it readable, but the previous turn is re-written every turn and the drop is a history edit — a 400 or dropped thinking on Opus 5.5 / Fable 5.1. Viable on Sonnet 5 only. |
| No auto-recall; rely on the `memory_recall` tool | Append-only for free, but adds an iteration and latency to turns that need memory, and reverses auto-recall's design (see [memory.md](memory.md)). |
| `turn_context` column on `messages` | Requires updating the user row after insert, and puts injected context next to what the user said. |

## Cache Intent `[proposed]`

`ChatParams` gains an optional field, set only by callers whose transcript will be sent again:

```ts
interface CacheIntent {
  /** Stable per transcript — the conversation id. Routing / accounting key. */
  key: string;
  /** "short" ≈ minutes between requests; "long" ≈ a human reply gap. */
  retention: "short" | "long";
}
```

| Caller | Intent |
|-|-|
| `handle-message` → `runStreamingAgentLoop` | `{ key: conversationId, retention: "long" }` (see [Retention](#retention)) |
| `run-agentic-stage` → `runStreamingAgentLoop` | `{ key: conversationId, retention: "short" }` |
| The loop's in-step non-streaming replay | Reuses the iteration's `chatParams`, so it reads the same cache |
| Summarization, degraded-reply synthesis, sub-agent calls, `typed.ts`, artifact extraction | None — a breakpoint on a tail that is never re-sent is a pure 1.25–2× write surcharge |

### Adapter mapping

| Provider | How it caches | What the adapter sends | Usage mapping |
|-|-|-|-|
| Anthropic | Only at `cache_control` breakpoints | Last tool and system block marked at the retention TTL, plus top-level `cache_control: { type: "ephemeral", ttl }`. Without an intent: tools and system at 5 minutes, as today. | `inputTokens` = `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` |
| OpenRouter (Claude, Gemini) | Passes `cache_control` through | The same markers, plus `session_id: key` for sticky routing | `prompt_tokens`; `prompt_tokens_details.cached_tokens` / `cache_write_tokens` |
| OpenAI | Automatic from 1,024 tokens | `prompt_cache_key: key`; retention ignored (GPT-5.6+ offers only `30m`, earlier models default to extended retention) | `prompt_tokens`; `prompt_tokens_details.cached_tokens` |
| xAI | Automatic, cached per server | `x-grok-conv-id: key` request header | `prompt_tokens`; `prompt_tokens_details.cached_tokens` |
| Other OpenAI-compatible (DeepSeek, Groq, vLLM, …) | Automatic prefix caching, where offered | Nothing — strict servers reject unknown fields | Whatever the server reports |

`retention` maps to Anthropic's 5-minute / 1-hour TTL (directly, or through OpenRouter) and is ignored elsewhere.

**Which OpenAI-compatible dialect applies** is configuration, not URL sniffing: `llm_providers.attrs.cacheDialect` (`"openrouter" | "openai" | "xai" | "none"`) replaces today's `promptCaching` boolean, which already encodes exactly this for OpenRouter. The setup wizard sets it from the provider type it configured; `custom` defaults to `"none"`, and an xAI row sets `"xai"`.

### Anthropic specifics

- **Breakpoints: three of four slots.** Tools, system, and the automatic tail. The tools and system markers stay because they give read points that survive a messages-level miss (compaction, an image turn) and a system-level miss (a core-memory edit) respectively.
- **Automatic over an explicit tail marker.** The server places the breakpoint on the last cacheable block, walks back past ineligible ones (empty text, thinking), and moves it forward each request. An explicit marker on the last block works on third-party Anthropic-compatible endpoints too; it needs every message normalized to block arrays and has the empty-block edge cases. `llm_providers.base_url` is null for Anthropic today — see [Open questions](#open-questions).
- **TTL ordering.** A 1-hour automatic tail after a 5-minute tools or system marker is a 400, so all three take the intent's TTL.
- **Lookback.** An iteration appends roughly 3–4 positions (thinking, text, a `tool_use` run, a `tool_result` run); a turn boundary roughly 5–8 (the final reply plus the next user message). Both are well inside the 20-position window, so the fourth slot stays free. A turn shape that appends more than 20 positions in one request would need an intermediate breakpoint.
- **`countTokens`** builds its own request and sends no top-level `cache_control`.
- **Thinking and effort** are not set by the adapter today. Changing either later invalidates the messages cache; they must be pinned per route, never varied per request.

## Retention `[proposed]`

A turn's cache is read by the next turn only if the entry is still alive, so the TTL choice rests on how long the user takes to reply.

Illustrative, Sonnet 5 input cost per turn, assuming a 38k-token prefix (8k tools and system, 30k transcript), two iterations, and about 2k new tokens per iteration. Output is excluded; it is the same in every column.

| Gap to the next turn | No transcript caching (today) | 5-minute TTL | 1-hour TTL |
|-|-|-|-|
| 2 minutes | ≈ $0.15 | ≈ $0.024 | ≈ $0.030 |
| 15 minutes | ≈ $0.15 | ≈ $0.11 | ≈ $0.030 |
| Over an hour | ≈ $0.15 | ≈ $0.11 | ≈ $0.17 |

- Under 5 minutes, both TTLs read; 5 minutes is slightly cheaper because deltas are written at 1.25× instead of 2×.
- Between 5 and 60 minutes, only the 1-hour TTL reads — the case it exists for.
- Over an hour, both write the whole prefix; 1 hour pays 2× for it.

Pipeline stages run their iterations back to back, so `"short"` is right there. For chat, `"long"` is the default proposal, to be confirmed against measured reply gaps. The query below measures start-to-start gaps between turn-starting user rows, which approximates the cache-relevant gap to within one turn's duration:

```sql
with turns as (
  select created_at - lag(created_at) over (partition by conversation_id order by created_at) as gap
  from messages where role = 'user' and jsonb_typeof(content) = 'string'
)
select count(*) filter (where gap < interval '5 minutes') as under_5m,
       count(*) filter (where gap >= interval '5 minutes' and gap < interval '1 hour') as five_to_60m,
       count(*) filter (where gap >= interval '1 hour') as over_1h
from turns where gap is not null;
```

**Keep-alive pings** (a `max_tokens: 0` request shortly before a 5-minute entry expires) are rejected: they need a scheduler per idle conversation, and `max_tokens: 0` is rejected with `stream: true`. They also cost more than they save: each ping reads the whole prefix (0.1×, 0.05× on Opus 5.5), while the 1-hour TTL's premium applies only to newly written tokens — in a warm conversation, the turn's delta, far smaller than the prefix.

## Usage Accounting `[proposed]`

`Usage.inputTokens` is the **total prompt size**. `cacheReadTokens` and `cacheCreationTokens` are subsets of it.

- The Anthropic adapter sums its three fields; OpenAI-compatible adapters already report the total and additionally read `prompt_tokens_details.cached_tokens` (and `cache_write_tokens` where present).
- `shouldSkipCounting` and `messages.input_tokens` keep their meaning — the context the request occupied — with no change at their call sites.
- The `gen_ai.usage.input_tokens` span attribute is the total, per the OpenTelemetry convention.
- The `cogmo.llm.tokens` counter records `type: "input"` as the uncached remainder (total minus reads minus writes), so its four types stay disjoint and sum to billable categories. For Anthropic that leaves `input` where it is today; for OpenAI-compatible providers it drops the cached share that `prompt_tokens` currently puts there.
- The loop's turn totals carry the cache fields, so the `agent loop complete` log shows the turn's hit rate.

The persisted per-turn input is the sum across the turn's iterations, which overstates the next turn's starting size on multi-iteration turns. That errs toward counting more often, not less, and stays as it is.

## Interactions

- **Compaction.** Strategy 0 supersession, Strategy 1 clearing and Strategy 2 summarization rewrite history and invalidate the cache from the first rewritten position — by design, see [context-management.md](context-management.md). The summarization call could itself read the parent's cache by reusing the parent's exact tools, system and messages and appending its instruction; that is a follow-up.
- **Inngest replays.** Every byte of `system` and `messages` derives from step results or the event payload, so a replayed invocation sends the same prefix; no bare-body clock or non-durable read may reach them. The `tools` array is the exception: each invocation rebuilds it from live reads of the image, skill, sub-agent and MCP catalogs (`handle-message.ts`, `run-agentic-stage.ts`). A catalog edit landing mid-run changes the prefix at position 0 — a full miss for the rest of the turn, and on Opus 5.5 / Fable 5.1 a thinking-block mismatch. Accepted as a concurrent-operator residual, the same class as the `auto-recall` gate; memoizing the definitions in a step is the fix if it ever bites.
- **Preserved thinking.** Freezing the system prompt removes the one history edit that happens on every turn. The remaining edits — configuration changes to the system prompt, all three compaction strategies (Strategy 0 runs every turn and rewrites an earlier result whenever a same-tool cluster crosses its trigger), the ephemeral `empty_end_turn` continuation prompt, a tool-catalog edit mid-run, and image turns (below) — are tracked in `todo.md`.
- **Image turns.** The current turn sends resolved image and document blocks; later turns load the row as its persisted JSON string. Anthropic treats added or removed images as a messages-cache invalidation, so the turn after an image turn re-writes from that message on. It is also a preserved-thinking edit. Out of scope here; tracked in `todo.md`.
- **Model switches.** Caches are per model. A `/model` change or a fallback to another provider starts cold.

## Verification `[proposed]`

1. **Prefix-stability invariant (CI, no network).** For a two-turn conversation whose first turn makes a tool call, every request's `tools`, `system` and `messages` — with `cache_control` stripped — is a byte prefix of the next request's. Unit level: `handle-message` with a provider that captures `ChatParams`. Integration level: the same assertion over llmock's request journal. It fails today at the system block on turn 2. This is the guard against the next invalidator, which usage numbers only show after the bill.
2. **Adapter tests.** Marker placement and TTLs per intent; no top-level `cache_control` without an intent; usage totals and cache subsets for each provider's usage shape.
3. **Fast-path regression.** A large conversation whose usage is mostly cache reads does not make `shouldSkipCounting` return true.
4. **Render equality.** `renderTurnContext` over the current turn's in-run inputs equals its output over the reloaded row.
5. **One live recording run** with real keys: on turn 1's second iteration, `cache_read_input_tokens` covers tools, system and the transcript; on turn 2's first iteration, it covers turn 1. If not, the cache-diagnostics beta (`cache-diagnosis-2026-04-07`) names the section that diverged. The same run on Opus 5.5 with `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` should log no `input_transformations` outside image turns and compaction.
6. **In production**, the existing per-call cache attributes and counters give a hit ratio of cache reads over total input per model.

Recorded fixtures match on the last user message (`match: { userMessage }`), which the clock in the system prompt never reached. Moving the time and recalled memories into it makes every chat cassette's key depend on them. `normalizeContent` (`test/llmock-setup.ts`) gains a rule for the time line, applied to string content and to the multipart text parts the OpenAI-compatible adapter sends for image turns, and every chat cassette is re-recorded.

## Implementation Plan `[proposed]`

1. **Cache intent and usage accounting.** `ChatParams.cache`, the Anthropic mapping, usage totals across adapters, the metric split, loop totals. Iterations 2 and later of every tool-using turn read the transcript. Until step 2 lands, nothing reads across turns, so a single-iteration turn pays 25% more on the transcript it writes; the change nets out cheaper once roughly 28% of turns run two or more iterations (`cogmo.agent.iterations` shows the share). Ships with `retention: "short"` everywhere.
2. **Turn context.** Frozen system prompt, `turn_contexts`, `renderTurnContext` in both loop callers, the frozen voice decision, the llmock normalizer and re-record, and `retention: "long"` for chat. Reads across turns, for every provider.
3. **OpenAI-compatible routing hints.** `attrs.cacheDialect` with its data migration from `promptCaching`, OpenRouter `session_id` and markers, OpenAI `prompt_cache_key`, xAI `x-grok-conv-id`.

## Open questions

- **Chat retention.** `"long"` until the reply-gap query says otherwise.
- **Preserved-thinking enforcement.** Whether the Anthropic account was created on or after 2026-08-31 decides whether the remaining system-prompt edits (core memory, steering rules, tool catalog) are 400s today. On Opus 5 and 5.5 they could become appended `role: "system"` messages; on Sonnet 5 they cannot.
- **Anthropic-compatible endpoints.** If an Anthropic-protocol `llm_providers` row ever points at a third-party endpoint, check that it accepts top-level `cache_control`, or fall back to an explicit tail marker for that row.
- **OpenRouter non-Claude routes.** OpenRouter translates a block-level `cache_control` into `prompt_cache_breakpoint` for OpenAI models, dropping the TTL; its docs don't say what other upstreams (xAI, DeepSeek) do with it. Verify with a recorded request before step 3 enables markers for every OpenRouter model.

## Sources `[research]`

- Anthropic, Prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic, Cache diagnostics — https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics
- Anthropic, Mid-conversation system messages — https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
- Anthropic, Extended thinking (caching with thinking) — https://platform.claude.com/docs/en/build-with-claude/thinking
- Anthropic, "Prompt caching is everything" — https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything
- Manus, "Context Engineering for AI Agents: Lessons from Building Manus" — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- OpenAI, Prompt caching — https://developers.openai.com/api/docs/guides/prompt-caching
- xAI, Prompt caching — https://docs.x.ai/developers/advanced-api-usage/prompt-caching
- OpenRouter, Prompt caching — https://openrouter.ai/docs/guides/best-practices/prompt-caching
- OpenTelemetry GenAI semantic conventions — https://github.com/open-telemetry/semantic-conventions-genai
