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

The first three are per-turn state. The rest look like configuration but aren't all rare: the agent edits core memory during ordinary turns, and channel-scoped rules follow which channel sessions are active. Pipeline runs add another source: stage turns send a narrower `tools` array and their own `# Tools` section in the same conversation as chat turns. A changed system block invalidates every cached message behind it, so moving the clock alone isn't enough — recall changes the block on nearly every turn.

**Tool-call inputs come back from the database in a different key order.** The loop appends the model's `tool_use` input as parsed from the stream, in the order the model emitted its keys. `messages.content` is `jsonb`, which stores object keys by length and then bytewise, so the next turn reloads `{"prompt": …, "model": …}` as `{"model": …, "prompt": …}`. Every turn after a tool call re-sends that call with different bytes: the cached prefix breaks at the first reordered input, on Anthropic and on the OpenAI-compatible path (whose `arguments` string is `JSON.stringify(input)`). Measured on Sonnet 5: the reordered history missed its cache from that call on, and cache diagnostics reported `messages_changed`. The preserved-thinking check ignores key order, so this costs cache hits only (see [Validation](#validation)).

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
| Longer TTLs must precede shorter ones in a request. Writes cost 1.25× (5 min) or 2× (1 h); reads 0.1×, 0.05× on Opus 5.5, 0.025× on Fable 5.1 and Mythos 5.1. A read refreshes the entry at no cost. The TTL runs from the start of the request. | Anthropic prompt-caching docs |
| Minimum cacheable prefix: 512 tokens on Opus 5.5 and Opus 5, 1,024 on Sonnet 5, 4,096 on Haiku 4.5. It counts the whole prefix, tools and system included. | Anthropic prompt-caching docs |
| Use the 1-hour TTL "when storing a long chat conversation where the user may not respond within 5 minutes." | Anthropic prompt-caching docs |
| Anthropic `input_tokens` is only the tokens after the last breakpoint; total = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. | Anthropic prompt-caching docs |
| `gen_ai.usage.input_tokens` "SHOULD include all types of input tokens, including cached tokens"; the Anthropic mapping sums the three fields. `cache_creation` was renamed `cache_write` (Development stability). | OpenTelemetry GenAI semantic conventions |
| OpenAI caches automatically from 1,024 tokens. `prompt_cache_key` routes related requests to the same cache on models before GPT-5.6 and separates cache accounting on 5.6+. Usage reports `cached_tokens` inside a total that includes them. | OpenAI prompt-caching guide |
| xAI caches automatically; `x-grok-conv-id` "routes requests with the same conversation ID to the same server. Since cache entries are stored per-server, this maximizes your cache hit rate." | xAI prompt-caching docs |
| No open-source library supplies a provider-neutral cache intent. The Vercel AI SDK covers all four providers, each through its own `providerOptions` (Anthropic `cacheControl` with `ttl`, OpenAI `promptCacheKey`, xAI `promptCacheKey` on the Responses API only), and only behind `generateText` — adopting it for text calls would break the raw-SDK rule. LangChain.js's `anthropicPromptCachingMiddleware` and LiteLLM's `cache_control_injection_points` are single-provider or Python. | AI SDK provider docs; LangChain.js and LiteLLM docs |
| The AI SDK 7 usage types keep the total inclusive, with cache counts as subsets — the same convention as [Usage Accounting](#usage-accounting). The provider-spec type carries `inputTokens: { total, noCache, cacheRead, cacheWrite }`; the usage `generateText` returns carries `inputTokens` plus `inputTokenDetails.{noCacheTokens, cacheReadTokens, cacheWriteTokens}`. Its own OpenRouter and xAI converters get the arithmetic wrong in different ways. | AI SDK 7.0 migration guide and provider source |
| promptcachelint (Python, MIT) diffs consecutive requests segment by segment — each tool, system block and message block — with cache markers stripped, and flags a turn that appends more than 20 positions. `assertAppendOnly` follows that design. | github.com/OsmnvAslan/promptcachelint |
| Zep places a memory block after the last breakpoint and replaces it each turn, measuring 1.3–1.9× lower cost over 18–54 turns — against memory in the system prompt, the layout this design also leaves. Mastra keeps observational memory append-only "to keep the prompt prefix cacheable". | Zep blog (2026-06-24); Mastra docs |
| Keep the system prompt and tool list fixed for a session; deliver changes in the next turn's messages and restrict tools without removing them. Claude Code keeps every tool in every request and implements plan mode as tools; Manus masks instead of removing; OpenAI's `allowed_tools` restricts a turn "but not modify the list of tools you pass in, so you can maximize savings from prompt caching"; Letta measured 240 system-prompt variants on one agent at an 83.8% hit rate. | Claude Code blog; Manus blog; OpenAI function-calling guide; letta-code #4551 |
| OpenRouter passes Anthropic `cache_control` through (per-block, and top-level for the Anthropic, Vertex, Azure and Bedrock providers); `session_id` / `x-session-id` pins sticky routing; usage reports `cached_tokens` and `cache_write_tokens`. | OpenRouter prompt-caching docs |

## Principles `[proposed]`

1. **The system prompt is a stored snapshot.** It is rendered once per conversation epoch and sent unchanged until the next one. Nothing per-turn goes in it. Core memory that changes during an epoch is announced in the next turn; a change to instructions — rules, prompt text, tools — starts a new epoch, so instructions always carry system authority.
2. **The transcript is append-only.** What the model saw on one request, it sees again byte-identical on every later request, until compaction deliberately rewrites it. That includes key order inside tool-call inputs.
3. **Per-turn state belongs to its turn.** It is rendered once, stored as the exact text sent, and re-sent as those bytes on every later request.
4. **One prefix per conversation.** Every turn in a conversation — chat or pipeline stage — sends the same `tools` and system prompt. Modes are expressed in messages and enforced at dispatch, never by changing what the request advertises.
5. **Cache intent is provider-neutral; wire format is the adapter's.** Domain code says "this transcript will be re-sent"; adapters decide what that means on the wire.
6. **Usage reports total prompt size.** Cache reads and writes are subsets of `inputTokens`, never in addition to it.

## Turn Context `[proposed]`

The per-turn state that today sits in the system prompt moves into a **turn context block** on each turn-starting user message: a row created from inbound messages or a stage prompt. Tool-result rows never get one — Anthropic requires `tool_result` blocks to come first in their message.

### Contents

| Field | Source |
|-|-|
| Time | `messages.created_at` of the user row, formatted in the configured user timezone |
| Recalled memories | the `auto-recall` step, deduplicated (below), inside the untrusted-context envelope |
| Reply modality | `voice` or `text`, from the per-turn voice decision (`resolveVoiceMode`) — data only; the voice-style guidance is a standing section of the system prompt that applies when the modality is `voice` |
| Delivery channels | the channel types this reply goes to, read inside the render step — data only; the rules for each channel stay in the system prompt |
| Core-memory changes | blocks changed since the snapshot and not yet announced, with their current content (see [System Prompt Snapshot](#system-prompt-snapshot)) |

Everything in the block is data; instructions live in the system prompt (see [System Prompt Snapshot](#system-prompt-snapshot)). Stage prompts carry the time, delivery channels and core-memory changes; they run no auto-recall and no voice.

Every turn-starting message carries its own time, so the model also sees a timeline of the conversation — useful for relative references ("what I asked you yesterday").

- **The time is when the turn was handled**, not when the user sent it: `created_at` is set by `create-user-message`, after debounce and transcription. That is what "current time" means for the reply; after an outage it trails the send time.
- **Stored as rendered text.** A later change to the timezone, the format or the envelope applies to new turns only; past turns keep the bytes they were sent with. Re-rendering history instead would make every such change a history-wide edit: a full cache rewrite for every conversation and, where preserved thinking is enforced, a 400 on every later turn.
- **Rows from before this ships have no turn context** and render none, so no formatter ever has to reproduce them. The deploy is still one full rewrite per live conversation, because the system prompt changes.
- **The compaction summary carries no time.** `loadTurnHistory` emits it as a synthetic user message with no row behind it.

### Rendering

A leading text block on the user message, ahead of the user's own content — matching Anthropic's long-context guidance of data first, question last:

```
<turn_context>
Current time: Friday, September 25, 2026, 09:14 (Europe/London)

<recalled_memories>
…
</recalled_memories>

Reply modality: voice
</turn_context>
```

The recalled-memories element carries the data-not-instructions header of the untrusted-context envelope (`todo.md`), built in from the start.

**Rendered once**, by a `render-turn-context` step that runs after compaction (see Deduplication). The step writes the text to `turn_contexts` and returns it; the loop sends that string, and later turns load it from the table. The bytes are identical by construction rather than by re-rendering.

The block ends with a blank line. The OpenAI-compatible adapter sends a text-only user message as its text blocks joined with no separator, so the separation has to be part of the rendered text.

Every input comes from a step result or the event payload. Voice-mode resolution reads the profile, the conversation and the delivery handle, none of them durable, so its result is frozen in a step. The delivery channels are read inside the render step.

Recalled memories are data, not instructions, and move from the system prompt — the operator-authority slot — into user content. That also narrows an injection surface: stored memories can carry text that originated in web pages or tool output.

### Deduplication

Auto-recall returns up to ~2,000 tokens per turn; rendering all of it every turn would grow the transcript by that much each turn. A turn keeps only memories whose content isn't in a turn context that survives this turn's compaction. Compaction runs first and counts the undeduplicated block, an upper bound. Deduplicating before compaction would drop a memory an earlier turn showed, then lose it when Strategy 2 or 3 removes that turn. Later turns compare against the stored structured list (below); once a summary moves the window forward, a memory can be recalled again.

### Data model

```
turn_contexts
  id           UUID PRIMARY KEY DEFAULT uuidv7()
  message_id   UUID NOT NULL UNIQUE REFERENCES messages(id)  -- the turn-starting user row
  rendered     TEXT NOT NULL                                 -- the exact block sent
  context      JSONB NOT NULL                                -- TurnContextSchema
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
```

`TurnContextSchema` is `{ recalledMemories: string[], voiceMode: boolean, channelTypes: string[], announcedCoreMemoryKeys: string[] }` — the structured inputs, kept for deduplication, announcement tracking and provenance. `rendered` is what is sent. Every turn-starting row written after this ships has one. Owned by `agent/store/`.

A side table rather than a column on `messages`: the row is written after the user row exists, so a column would mean updating the user row. It also keeps `messages.content` as "what the user said", which the web UI (through `Transport`) and the Observer read. An Observer extracting facts from the user row must not re-extract the memories recall injected.

**Written by the render step, before the agent loop.** The `create-user-message` step returns the new row's id for this. The insert is `ON CONFLICT (message_id) DO UPDATE` with a no-op set, returning the stored row, so a retried step returns the first attempt's text (see `.claude/rules/inngest.md`). A turn that fails later keeps its context, and the next turn sends the same bytes the failed turn did.

### Alternatives considered

| Option | Why not |
|-|-|
| Time as a trailing block on the latest message only, not persisted | The next turn removes it from an earlier message: a history edit that misses the cache from that message on and invalidates later thinking blocks. |
| Date-only in the system prompt | Invalidates daily instead of per minute, loses time of day, and leaves recall in place. |
| Mid-conversation `role: "system"` message | Not available on Sonnet 5, so every call site needs a capability gate and a fallback; the block's contents are data and don't need operator authority. |
| Recall as a trailing block after the last breakpoint, replaced each request (Zep's layout) | No schema change and no accumulation, but a history edit under the thinking blocks that followed it — see [Persisted versus trailing memories](#persisted-versus-trailing-memories). |
| No auto-recall; rely on the `memory_recall` tool | Append-only for free, but adds an iteration and latency to turns that need memory, and reverses auto-recall's design (see [memory.md](memory.md)). |
| `turn_context` column on `messages` | Requires updating the user row after insert, and puts injected context next to what the user said. |

### Persisted versus trailing memories

Both layouts take recalled memories out of the system prompt, which is where most of the saving comes from — Zep's 1.3–1.9× is measured against memory in the system prompt. They differ in what happens to a memory after the turn that recalled it: this design keeps it in the transcript, deduplicated; Zep's replaces it each turn with a fresh block after the last breakpoint.

**Where trailing memories are better:**

- **Simpler storage.** No `turn_contexts` and no deduplication.
- **Cleaner context.** The model sees only the memories relevant to the current message; nothing accumulates mid-transcript to dilute attention.
- **No stale facts.** A fact Hindsight has since updated stays in this design's transcript at the turn that recalled it, next to the newer version. Trailing memories are always current.
- **Flat cost.** Trailing memories cost the same every turn. Persisted ones are written once, then re-read at the cache rate by every later request, so their cost grows until a compaction summary resets it.

Illustrative cost of memories per turn, assuming ~1.5k tokens per recall, two requests per turn, 40% of each recall new, and the 1-hour TTL:

| Model | Trailing | Persisted, turn 10 | Persisted, turn 50 | Break-even turn |
|-|-|-|-|-|
| Sonnet 5 | ≈ $0.006 | ≈ $0.005 | ≈ $0.015 | ~14 |
| Opus 5.5 (reads 0.05×) | ≈ $0.012 | ≈ $0.008 | ≈ $0.017 | ~28 |

Either is small next to re-reading the transcript itself — about $0.012 per turn at 30k tokens on Sonnet 5. The table assumes each turn arrives inside the TTL. After a longer gap the accumulated memories are re-written with the rest of the prefix at the 2× write rate instead of read, while trailing memories cost the same as ever — so in a conversation used once a day, the trailing layout's lead starts earlier than the break-even column shows.

**Where persisted memories are better:**

- **Preserved thinking.** Removing last turn's block, or moving the block to the end of each tool iteration, edits the history the turn's thinking blocks were bound to. Where the check is enforced, that is a 400, or under `drop_block` every thinking block from the edit on is dropped — and dropped blocks change the messages cache from their position, so the cache goes too. This account isn't enforced (see [Validation](#validation)); a new key, a new organization, or a model that enforces for everyone would be.
- **Automatic caching keeps working.** With a trailing block, Anthropic's automatic breakpoint lands on the memory block itself, paying a cache write for it on every request that is never read back. Trailing memories need the breakpoint placed by hand just before the block: a "trailing, uncached" notion in `ChatParams` and marker placement in every adapter, against a single intent field here.
- **Tool loops.** A trailing block left in place for the rest of its turn forces the next turn to re-write that whole turn, tool results included, once the block is dropped; one moved to the end of every request is paid at the full input rate on every iteration.
- **Provenance.** `turn_contexts` records what the model saw on each turn, so any past request can be rebuilt; trailing memories survive only as long as Inngest's step state.
- **Grounding.** An earlier answer keeps the memory it was based on beside it.

The deciding factor is the first: the persisted layout's costs are soft and bounded by deduplication and compaction, while the trailing layout fails hard the moment the preserved-thinking check applies.

**A later path to both** `[research]`. On Opus 5, Opus 5.5 and Fable, a turn-scoped mid-conversation system message (`clear_at: "next_user_message"`, beta `mid-conversation-system-clear-at-2026-08-21`) renders for one turn and then stays in the transcript cleared, costing no input tokens. That is a trailing block without the history edit and without accumulation. It is not available on Sonnet 5, where mid-conversation system messages don't exist at all; it can't carry `cache_control`, so the breakpoint goes on the preceding user turn; and it gives recalled memories operator authority, which widens the injection surface of stored text that originated in web pages or tool output.

## System Prompt Snapshot `[proposed]`

Identity, `# User` (core memory), `# Tools`, `# Capabilities` and `# Rules` stay in the system prompt, which becomes a **snapshot**: rendered and stored when an epoch opens, then sent unchanged by every turn until the next one.

Never editing the system prompt mid-session, and delivering changes in the next turn's messages, is what Claude Code, Anthropic's guidance and Letta's measurements all point to ([Research Base](#research-base)).

What may be announced is limited by authority. An announcement is user content, and neither the model nor this design can let user content supersede a system instruction — nor tell a genuine announcement from text a fetched page or recalled memory imitates. So only data is announced; instructions change by opening an epoch.

- **Core memory is announced.** It is data about the user, and the agent edits it during ordinary turns — its guidance says "Update them as you learn new things" — so re-rendering on every edit would rewrite the prefix every few turns. A block changed since the snapshot, and not yet announced since that change, is announced in the next turn context with its current content. The turn that made the edit already has the tool result in its transcript.
- **Rules open an epoch.** A rule added, changed or retired changes the system prompt at the next turn, with system authority intact. Rule changes come from the Observer's graduation and from operators, so they are occasional.
- **Channel-scoped rules stay in the system prompt**, all of them, each labelled with its channel ("On telegram: …"), whether or not that channel is active. The turn context names the channels the reply goes to. Rendering only the active channels' rules would change the system prompt whenever a session expires or opens; moving the rules into user content would demote them, and a channel-scoped rule can be a `safety` rule.
- **Voice style is standing guidance.** The system prompt always carries the voice-style section, which applies when a turn context says `Reply modality: voice`, so alternating voice and text turns change only data.
- **Rule order.** Rules sort by priority, then id. `getActiveRules` sorts by priority alone, and correction rules all share priority 100, so ties can come back in a different order after an Observer update.

**An epoch opens** at a conversation's first turn, at a turn whose compaction stored a summary, and at a turn whose configuration digest differs from the snapshot's. The digest covers everything the snapshot renders except core memory: the profile's base prompt or the code-owned identity and onboarding text, the capabilities guidance, the rules, and the tool definitions. A deploy that edits prompt text in `prompt.ts` or the service guidance therefore reaches existing conversations at their next turn, as does a rule change or a new skill. Compaction already rewrites the prefix, so its refresh costs nothing extra; the others are deliberate full rewrites.

**Opening an epoch strips thinking blocks from the turns before it.** They are bound to the previous system prompt, so replaying them is a mismatch wherever preserved thinking is enforced. All of them precede the new epoch, so together they are a leading run, which the check allows to be removed. The same applies to the turns a compaction keeps verbatim — the keep-tail case in `todo.md`'s preserved-thinking audit.

```
system_prompt_snapshots
  id               UUID PRIMARY KEY DEFAULT uuidv7()
  conversation_id  UUID NOT NULL REFERENCES conversations(id)
  opened_by        UUID NOT NULL UNIQUE REFERENCES messages(id)  -- the turn-starting row that opened the epoch
  rendered         TEXT NOT NULL                                 -- the exact system prompt sent
  config_digest    TEXT NOT NULL                                 -- digest of everything rendered but core memory
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
```

A turn decides in a step whether it opens an epoch and loads or writes the snapshot there, idempotent on `opened_by`.

On Opus 5, 5.5 and Fable, a rule change could instead be a mid-conversation `role: "system"` message, which has operator authority and avoids the rewrite. Sonnet 5 has none, so an epoch is the one path that works on every model.

## One Prefix per Conversation `[proposed]`

`start_pipeline` routes the user's channel sessions onto the run's conversation, so chat turns (`handle-message`) and stage turns (`run-agentic-stage`) alternate in one transcript. Stage turns today narrow `tools` to the stage allowlist (`restrictToStage`) and render their own `# Tools` section. Every switch rewrites position 0: a full miss each time and, where preserved thinking is enforced, a 400 for the chat turn that replays thinking blocks bound to the stage's tool set.

Stage turns instead send the conversation's snapshot and the same frozen tool definitions as chat turns. The allowlist moves into the stage prompt, which already carries the stage's instructions, and is enforced at dispatch: a call to a tool outside it gets an `is_error` result naming the stage's tools, without running.

Keeping every tool in every request and restricting at dispatch is what Claude Code (plan mode as tools), Manus ("mask, don't remove"), OpenAI (`allowed_tools`) and Anthropic's guidance describe ([Research Base](#research-base)).

Anthropic has no per-request `allowed_tools`, and changing `tool_choice` invalidates the messages cache. Its append-only alternative is mid-conversation tool changes: `tool_addition` / `tool_removal` blocks in a `role: "system"` message withdraw or re-offer a declared tool without touching the cached prefix (beta `inline-tools-2026-09-15`; the older `mid-conversation-tool-changes-2026-07-01` still works by reference). They exist only on models with mid-conversation system messages, not Sonnet 5, so dispatch enforcement is the portable path; on Opus 5, 5.5 and Fable a stage turn can also withdraw its disallowed tools this way. On OpenAI routes the adapter can send `allowed_tools` as well.

## Canonical Tool Inputs `[proposed]`

A `tool_use` block's `input` is put into canonical key order — sorted keys at every depth, arrays in order, the RFC 8785 ordering the `canonicalize` library already provides for `canonicalJson` (`src/agent/repair.ts`) — at both boundaries where it enters a transcript:

- **In the loop**, when the streamed tool call becomes part of the assistant message, so the in-turn transcript and every later request carry the same order.
- **At the store boundary**, when `messages.content` is read back from `jsonb`, so a reload reproduces that order regardless of how Postgres stored it.

The model never sees its own emission order again, only the canonical one, and that is safe: iteration 1's cache entry ends at the user message, and the preserved-thinking check ignores key order (measured, see [Validation](#validation)). Handlers receive the same values; only key order changes.

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
| `run-agentic-stage` → `runStreamingAgentLoop` | The same as chat — a run conversation's stage and chat turns share one prefix, and a 5-minute entry would expire before the next chat turn |
| The loop's in-step non-streaming replay | Reuses the iteration's `chatParams`, so it reads the same cache |
| Summarization, degraded-reply synthesis, sub-agent calls, `typed.ts`, artifact extraction | None — a breakpoint on a tail that is never re-sent is a pure 1.25–2× write surcharge |

### Adapter mapping

| Provider | How it caches | What the adapter sends | Usage mapping |
|-|-|-|-|
| Anthropic | Only at `cache_control` breakpoints | Last tool and system block marked at the retention TTL, plus top-level `cache_control: { type: "ephemeral", ttl }`. Without an intent: tools and system at 5 minutes, as today. | `inputTokens` = `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` |
| OpenRouter | Passes `cache_control` through to Claude and Gemini; other upstreams cache automatically and accept the markers without error (measured on xAI, DeepSeek and OpenAI) | Markers on `anthropic/` and `google/` models only — for Gemini an explicit marker on the last block rather than the top-level field, which OpenRouter supports on Vertex but not AI Studio; `session_id: key` on every model | `prompt_tokens`; `prompt_tokens_details.cached_tokens` / `cache_write_tokens` |
| OpenAI | Automatic from 1,024 tokens; GPT-5.6+ bills writes at 1.25× | `prompt_cache_key: key`; retention ignored (GPT-5.6+ offers only `30m`, earlier models default to extended retention) | `prompt_tokens`; `prompt_tokens_details.cached_tokens` / `cache_write_tokens` (GPT-5.6+) |
| xAI | Automatic, cached per server | `x-grok-conv-id: key` request header | `prompt_tokens`; `prompt_tokens_details.cached_tokens` |
| Other OpenAI-compatible (DeepSeek, Groq, vLLM, …) | Automatic prefix caching, where offered | Nothing — strict servers reject unknown fields | Whatever the server reports |

`retention` maps to Anthropic's 5-minute / 1-hour TTL (directly, or through OpenRouter) and is ignored elsewhere.

**Which OpenAI-compatible dialect applies** is configuration, not URL sniffing at request time: `llm_providers.attrs.cacheDialect` (`"openrouter" | "openai" | "xai" | "none"`) replaces today's `promptCaching` boolean, which encodes this for OpenRouter only.

- **Writers.** Three callers decide `promptCaching` today: the setup wizard and `cogmo provider add` (`src/cli/provider.ts`), which both persist through the `addProvider` use case (`src/agent/provider/add-provider.ts`), and non-interactive setup (`src/setup/non-interactive.ts`), which calls `createProvider` directly. All three decide the dialect instead, and the default belongs in `addProvider`, with non-interactive setup routed through it so the rule lives in one place. The provider types are `anthropic | openrouter | openai | custom`, with no xAI entry, so each writer takes an explicit dialect for a `custom` row and defaults to `"none"`.
- **Migration.** The boolean alone can't tell an OpenAI or xAI row from any other `custom` one, so the data migration derives the dialect once from each row's provider type and base-URL host: `openrouter.ai` → `openrouter`, `api.openai.com` → `openai`, `api.x.ai` → `xai`, anything else → `none`.

### Anthropic specifics

- **Breakpoints: three of four slots.** Tools, system, and the automatic tail. The tools and system markers stay because they give read points that survive a messages-level miss (compaction, an image turn) and a system-level miss (a new snapshot epoch) respectively.
- **Automatic over an explicit tail marker.** The server places the breakpoint on the last cacheable block and walks back past ineligible ones. The explicit fallback, for endpoints without automatic caching, converts a string-content last message to a single text block to carry the marker — safe, since the two cache identically (measured) — and skips empty blocks. See [Open questions](#open-questions).
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

For chat, and so for pipeline runs that share its prefix, `"long"` is the default proposal, to be confirmed against measured reply gaps. The query below measures start-to-start gaps between user-sent turns — pipeline stage prompts and scheduled fires are excluded by their inbound source, since their gaps are machine-driven — which approximates the cache-relevant gap to within one turn's duration:

```sql
with turns as (
  select m.created_at - lag(m.created_at) over (partition by m.conversation_id order by m.created_at) as gap
  from messages m
  join inbound_messages i on i.id = m.last_inbound_message_id
  where m.role = 'user' and jsonb_typeof(m.content) = 'string' and i.source = 'user'
)
select count(*) filter (where gap < interval '5 minutes') as under_5m,
       count(*) filter (where gap >= interval '5 minutes' and gap < interval '1 hour') as five_to_60m,
       count(*) filter (where gap >= interval '1 hour') as over_1h
from turns where gap is not null;
```

**Keep-alive pings** — a `max_tokens: 0` request, sent without streaming, shortly before a 5-minute entry expires — are rejected for now. On every model they need a scheduler per idle conversation: a durable timer firing every few minutes until the conversation goes quiet for good. Whether they also save money is arithmetic. A ping reads the whole prefix at the read rate; the 1-hour TTL instead pays 0.75× extra on each turn's newly written tokens. On a 30k-token prefix with a 4k-token delta, pings break even at about one per gap on Sonnet 5 (reads 0.1×), two on Opus 5.5 (0.05×) and four on Fable 5.1 and Mythos 5.1 (0.025×). A gap needs its first ping after about five minutes and another every four or so, so pings never pay on Sonnet 5, pay on Opus 5.5 only for gaps under about ten minutes, and on Fable 5.1 for gaps under about twenty; the 1-hour TTL is cheaper from there to the hour, and the ratio moves against pings as the prefix grows. If the chat model moves to Fable 5.1, the scheduler is the main objection left, and keep-alive is worth revisiting against measured gaps.

## Usage Accounting `[proposed]`

`Usage.inputTokens` is the **total prompt size**. `cacheReadTokens` and `cacheCreationTokens` are subsets of it — the convention the OpenTelemetry GenAI attributes and the AI SDK 7 usage shape share.

- The Anthropic adapter sums its three fields; OpenAI-compatible adapters already report the total and additionally read `prompt_tokens_details.cached_tokens` (and `cache_write_tokens` where present).
- `messages.input_tokens` keeps its meaning — input tokens billed over the turn — and `shouldSkipCounting` keeps reading it. The fast path's new-content estimate adds the rendered turn context's length to `userContentText.length`: the recalled memories and announcements are new input the previous turn's usage doesn't include.
- The `gen_ai.usage.input_tokens` span attribute is the total, per the OpenTelemetry convention.
- The `cogmo.llm.tokens` counter records `type: "input"` as the uncached remainder (total minus reads minus writes), so its four types stay disjoint and sum to billable categories. For Anthropic that leaves `input` where it is today; for OpenAI-compatible providers it drops the cached share that `prompt_tokens` currently puts there.
- The loop's turn totals carry the cache fields, so the `agent loop complete` log shows the turn's hit rate.

The persisted per-turn input is the sum across the turn's iterations, which overstates the next turn's starting size on multi-iteration turns. That errs toward counting more often, not less, and stays as it is.

## Interactions `[proposed]`

- **Compaction.** Strategy 0 supersession, Strategy 1 clearing, Strategy 2 summarization and Strategy 3 emergency truncation rewrite history and invalidate the cache from the first rewritten position — by design, see [context-management.md](context-management.md). The summarization call could itself read the parent's cache by reusing the parent's exact tools, system and messages and appending its instruction; that is a follow-up.
- **Inngest replays.** Every byte of `system` and `messages` derives from step results or the event payload, so a replayed invocation sends the same prefix; no bare-body clock or non-durable read may reach them. Today the `tools` array is not: each invocation rebuilds it from live reads of the image, skill, sub-agent and MCP catalogs (`handle-message.ts`, `run-agentic-stage.ts`), so a catalog edit mid-run — or a transient failure, since `buildSkillTools` catches a skill-list error and returns `[]` — changes position 0 for the rest of the turn. Each turn's tool definitions are therefore frozen in a step; the bare body still builds the handlers, and a call to a tool whose handler didn't load on this invocation returns an `is_error` result. Between turns, a changed catalog starts a new snapshot epoch.
- **Preserved thinking.** Freezing the system prompt removes the one history edit that happens on every turn. The snapshot announces core-memory changes and opens an epoch for instruction changes, stripping the thinking blocks bound to the old prompt; one prefix per conversation removes the stage switch; frozen tool definitions remove the mid-turn catalog change. The remaining edits — the compaction strategies (Strategy 0 runs every turn and rewrites an earlier result whenever a same-tool cluster crosses its trigger), the ephemeral `empty_end_turn` continuation prompt, and image turns (below) — are tracked in `todo.md`.
- **Image turns.** The current turn sends resolved image and document blocks; later turns load the row as its persisted JSON string. Anthropic treats added or removed images as a messages-cache invalidation, so the turn after an image turn re-writes from that message on. It is also a preserved-thinking edit. Out of scope here; tracked in `todo.md`.
- **Model switches.** Caches are per model. A `/model` change or a fallback to another provider starts cold.

## Validation `[confirmed]`

Live measurements, 2026-09-25, from scripts kept outside the repo, each against a fresh ~7k-token system prompt.

| Question | Result |
|-|-|
| Does each request read exactly what the previous one cached? (Sonnet 5; automatic caching plus tools and system markers, all `1h`) | Yes, exactly. Across three turns `cache_read` went 7,360 → 7,428, each equal to the previous request's read plus write; every write landed in `ephemeral_1h_input_tokens`. |
| Do string content and a single text block cache identically? | Yes. The block form read the string form's whole 7,360-token entry. |
| Does tool-call input key order change the cache key? | Yes. The same history with `{model, prompt}` in place of `{prompt, model}` missed 243 tokens; cache diagnostics: `messages_changed`. |
| Is cache diagnostics usable on this account? | Yes — it produced the `messages_changed` above (sent with the `cache-diagnosis-2026-04-07` header, since no longer required). |
| Is this account enforced for preserved thinking by default? (Opus 5.5) | No. Replaying two thinking blocks under an edited system prompt, without the beta header, returned 200. |
| Does a system-prompt edit count as a binding mismatch? | Yes. With `drop_block`, both thinking blocks were dropped as `prefix_binding_mismatch`. |
| Does tool-input key order count as a binding mismatch? | No. Reordered keys under `drop_block` gave `input_transformations: []`. |
| Does OpenRouter accept `cache_control` on non-Claude upstreams? | Yes, top-level and per-block, on xAI, DeepSeek (via Together) and OpenAI routes. Claude routes cached as on Anthropic direct (served by Claude Platform on AWS); OpenAI GPT-5.6 reported `cache_write_tokens`. |
| Do markers change xAI's hit rate through OpenRouter? | No. Over four pairs per variant — top-level and block markers, block only, none — an immediate repeat read 4,864 of 4,897 tokens in 3 or 4 of 4, regardless of markers. |
| Does a 1-hour entry outlive a gap that expires a 5-minute one? | Yes. After 6.5 minutes the `1h` entry read all 6,875 tokens; the `5m` entry had expired and was written again. |
| Does OpenAI's `prompt_tokens` include cached tokens? | Yes. The repeat reported `prompt_tokens` 4,711 with `cached_tokens` 3,840 (gpt-5.4-nano, `prompt_cache_key` set). |

## Test Plan `[proposed]`

Three separate claims need proving, and no single tier proves all three:

| Claim | Why it can fail | Where it is proven |
|-|-|-|
| **Byte stability** — every request's prefix is the previous request's, unchanged | A per-turn value in the system prompt, a history edit, a non-durable read on replay, a serializer reordering keys | Unit and integration tiers, every PR |
| **Wire mapping** — each adapter puts the intent on the wire and reads usage back correctly | A marker in the wrong place, a TTL-ordering 400, a missing routing key, uncached tokens reported as total | Unit and integration tiers, every PR |
| **Provider behaviour** — the provider actually serves our prefix from its cache | Anything the first two can't see: minimum sizes, lookback, TTL, a provider-side rendering difference | Live tier only |

Replay cannot prove the third. llmock records usage for OpenAI-shaped responses but not Anthropic's, and its Anthropic replay emits only `input_tokens` and `output_tokens`, zero unless a fixture overrides them. An upstream aimock change that records and replays Anthropic's `cache_*` fields — modelled on the one that added OpenAI usage — would let the integration tier assert on real recorded cache usage; until then that is the live tier's job.

### Harness

- **Injectable `fetch`** on `AnthropicProvider` and `OpenAICompatibleProvider`, as `OpenAIVoiceProvider` already takes for record/replay. Production passes the logging fetch it builds today.
- **`createWireRecorder()`** (`src/test/`) wraps a fetch and records each request's URL, headers and body exactly as sent. It tees the response to keep the usage object: Anthropic's `message_start` usage including the `cache_creation` TTL breakdown, and the OpenAI final chunk's `usage`. An optional request mutator lets the live tier add headers and fields without production code.
- **`assertAppendOnly(prev, next)`**, with `cache_control` stripped everywhere: `tools` and `system` equal, and `next.messages` starting with every message of `prev` byte-for-byte. A failure names the first diverging path (`system`, `tools[3]`, `messages[7].content[1].input`). It also counts the positions each request appends — a run of `tool_use` or `tool_result` blocks counting once — and fails past 20, the lookback window.

llmock's request journal can't serve here: it stores its own OpenAI-shaped conversion of an Anthropic request, without `cache_control`, system blocks or the top-level field.

### Unit tier

- `DefaultPromptSource.assemble` returns the same string at two different minutes under fake timers. Fails today.
- A tool input round-tripped through a PGlite `messages` row serializes identically to the in-loop block. Fails today.
- The loop sends exactly the text the render step stored, and a retried render step returns the stored row; tool-result rows and the compaction summary get no block; deduplication runs against the history after compaction.
- The snapshot: re-rendered only when an epoch opens; a core-memory edit leaves it unchanged and is announced once, in the next turn context; a rule change, a prompt-text change or a new tool changes the digest and opens an epoch; rules sort by priority, then id; opening an epoch strips earlier turns' thinking blocks.
- A stage turn sends the snapshot and the full frozen tool definitions; a call outside the stage allowlist returns an `is_error` result without running.
- **Replay equality** in `handle-message.replay.test.ts`: `llm-iter2`'s `ChatParams` from a fresh run equal those from a run where every earlier step is memoized through `@inngest/test`'s `steps:`. Checkpointing can collapse a real run's steps into one invocation, so the integration tier alone doesn't reliably exercise a replayed body.
- Anthropic adapter, per intent: no intent keeps today's 5-minute tools and system markers; `short` and `long` add top-level `cache_control` at the matching TTL with the markers at the same TTL; at most four breakpoints; `countTokens` sends no top-level field; usage sums to a total with the cache fields as subsets.
- OpenAI-compatible adapter, per dialect: `prompt_cache_key`, the `x-grok-conv-id` header, OpenRouter's `session_id` and markers, and nothing for `none`; usage from `prompt_tokens_details`.
- The loop passes the caller's intent on every iteration and to the in-step replay; summarization, degraded-reply synthesis, sub-agents and `chatTyped` send none.
- `shouldSkipCounting` does not skip for a large conversation whose usage is mostly cache reads.

### Integration tier (replay, every PR)

`src/test/prompt-caching.integration.test.ts` bootstraps the app in-process as `pipeline.integration.test.ts` does, with the chat provider built on the wire recorder and pointed at llmock.

**Anthropic conversation:**

1. A tool turn of at least two iterations, calling a tool whose model-emitted key order differs from `jsonb` order — the recorded `generate_image` call (`prompt`, then `model`) is one.
2. A follow-up with auto-recall returning memories from a seeded bank.
3. A voice-mode turn, reusing the voice fixtures.
4. A core-memory edit, announced in the next turn's context.
5. An image turn, followed by one more plain turn.

**Assertions:**

- `assertAppendOnly` over every consecutive pair of loop requests in the conversation, within turns and across them. The one declared exception is the turn after the image turn, which must diverge exactly at the image message; that pins the known residual instead of tolerating divergence in general.
- `system` is identical on every request and contains no time and no recalled context; the voice turn changes only the turn context's modality, and the core-memory edit changes the system prompt only at the next epoch.
- Each turn-starting message opens with its turn context, identical to `turn_contexts.rendered`. The time matches the row's `created_at` in the configured timezone, and a memory recalled on turns 2 and 3 renders once.
- Every loop request carries top-level `cache_control` at `1h`, with the tools and system markers at `1h`.

**A pipeline run conversation:** chat turns and a stage turn alternate. `assertAppendOnly` holds across each switch — same `tools`, same `system`, same `1h` TTL.

**OpenAI-compatible:** the recorded xAI-via-OpenRouter route runs a two-turn conversation with a tool call. `assertAppendOnly` holds over the Chat Completions bodies, which catches a reordered `arguments` string, and the dialect's fields are present.

The suite follows `.claude/rules/testing.md`: it runs alongside its noisiest peers before it counts as stable, since llmock's fixture pool is shared across forks.

### E2E tier

The smoke test's migrations check gains `turn_contexts` and `system_prompt_snapshots`. The rest of the path runs in-process at the integration tier, and in replay the subprocess can't show anything about provider caching that the integration tier doesn't.

### Live tier

`src/test/prompt-caching.live.test.ts`, in a `live` Vitest project run by `pnpm test:live`, skipped unless `LIVE=1` and the provider's key is set. It reuses the integration global setup. Chat providers point at the real endpoints through the wire recorder; Hindsight keeps llmock, recording into a throwaway fixture directory.

**A. Anthropic, the production chat model.** The integration conversation, run straight through well inside the TTL, minus its image turn — a known divergence pinned at the integration tier that would break A's exact relation and B's `error` mode. The recorder adds the `diagnostics` object to every request (`previous_message_id: null` first, then the previous response's id), since a fingerprint is stored only for requests that include it, and keeps the `anthropic-beta` header set constant, since a change makes the comparison `unavailable`.
- Each request reads exactly what the previous one cached: for every request `n` after the first, `cache_read(n) = cache_read(n−1) + cache_creation(n−1)`, within turns and across them. Any failure prints `diagnostics.cache_miss_reason`.
- The first request's `cache_read + cache_creation` exceeds the model's minimum cacheable prefix, so a pass can't be vacuous.
- `cache_creation.ephemeral_1h_input_tokens` is non-zero and `ephemeral_5m_input_tokens` is zero on the chat path.
- `input_tokens` covers only the tail after the last breakpoint.

**B. Opus 5.5 with preserved thinking enforced.** The same conversation as A. The recorder adds `thinking-binding-controls-2026-08-01` and `thinking.block_binding.prefix_mismatch_behavior: "error"`, so any history edit is a 400. The conversation completes, and `input_transformations` stays empty. Key order needs no check here: the binding ignores it, and A's exact relation already fails on a reordered input.

**C. TTL survival (nightly only).** Turn 1, a six-minute wait, then turn 2, whose first request reads turn 1's whole prefix. Only the 1-hour TTL makes that possible.

**D. OpenAI, xAI, and OpenRouter to Claude.** The same conversation through each dialect; xAI through OpenRouter until a direct xAI key exists. OpenAI and xAI cache best-effort — measured, xAI missed an immediate repeat about one time in eight — so their assertion is tolerant: from the second request on, `cached_tokens` is non-zero and covers most of the previous prompt, with one retry before failing. OpenRouter to Claude reports `cached_tokens` and `cache_write_tokens`, and gets A's relation, allowing one miss if OpenRouter moves the conversation to a different upstream.

**Cost and cadence.** A run costs cents, since after the first request almost every input token is a cache read. It runs locally with the keys from the root `.env`, and on a scheduled and manually dispatched GitHub workflow once API-key secrets exist there. It never runs on PRs.

### Production

The `chat` spans and `cogmo.llm.tokens` already carry cache reads and writes per call. A hit ratio per model — reads over total input — on multi-iteration turns is the standing regression signal; the `agent loop complete` log carries the same per turn.

### Fixtures

Recorded fixtures match on the last user message (`match: { userMessage }`), which the clock in the system prompt never reached. Moving the time and recalled memories into it makes every chat cassette's key depend on them. `normalizeContent` (`test/llmock-setup.ts`) gains a rule for the time line, applied to string content and to the multipart text parts the OpenAI-compatible adapter sends for image turns, and every chat cassette is re-recorded.

## Implementation Plan `[proposed]`

1. **Cache intent and usage accounting.** `ChatParams.cache`, the Anthropic mapping, usage totals across adapters, the metric split, loop totals, the injectable `fetch` and wire recorder, and live scenario A's within-turn assertions. Iterations 2 and later of every tool-using turn read the transcript. Until step 2, reads rarely cross a turn (only when the system prompt happens not to change), so a single-iteration turn usually pays 25% more on the transcript it writes; the step nets out cheaper once at most ~28% of turns iterate (`cogmo.agent.iterations`). Ships with `retention: "short"` everywhere.
2. **Turn context and canonical tool inputs.** Clock, recall and voice hint out of the system prompt (voice as a modality in the turn context, its style guidance a standing system-prompt section); `turn_contexts` with stored rendered text, the render step after compaction with deduplication and the envelope; the frozen voice decision; per-turn tool definitions frozen in a step; canonical tool inputs; the llmock normalizer and re-record; `retention: "long"` for chat and pipeline runs; the integration suite; live scenarios B and C. Reads across turns on every provider, except after a configuration change.
3. **System prompt snapshot and one prefix per conversation.** `system_prompt_snapshots` and epochs keyed on a configuration digest, core-memory announcements, every channel-scoped rule labelled in the snapshot with the delivery channels in the turn context, thinking blocks stripped when an epoch opens, and stage turns on the conversation's snapshot and tool definitions with the allowlist enforced at dispatch ([pipelines.md](pipelines.md) changes with it).
4. **OpenAI-compatible routing hints.** `attrs.cacheDialect` with its migration and writers, OpenRouter `session_id` and markers, OpenAI `prompt_cache_key`, xAI `x-grok-conv-id`, and live scenario D.

## Open questions

- **Chat retention.** `"long"` until the reply-gap query says otherwise.
- **Preserved-thinking enforcement.** This account is not enforced by default (measured), so the history edits that remain drop nothing today unless a request opts in. They still cost the cache, and they become 400s for a new account or a model that enforces for everyone.
- **Core-memory edit frequency.** The snapshot design assumes edits are frequent enough to matter; measuring them — edits per conversation-day — sizes the saving before step 3.
- **Anthropic-compatible endpoints.** If an Anthropic-protocol `llm_providers` row ever points at a third-party endpoint, check that it accepts top-level `cache_control`, or fall back to an explicit tail marker for that row.
- **Live tier in CI.** The scheduled workflow needs Anthropic, OpenAI and xAI API keys as repository secrets; until they exist, the live tier runs locally only.

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
- OpenAI, Function calling (`allowed_tools`) — https://developers.openai.com/api/docs/guides/function-calling
- Letta, prompt-cache misses from volatile system-prompt metadata — https://github.com/letta-ai/letta-code/issues/4551
- Vercel AI SDK, Anthropic provider — https://ai-sdk.dev/providers/ai-sdk-providers/anthropic
- Vercel AI SDK 7.0 migration guide (usage shape) — https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0
- promptcachelint — https://github.com/OsmnvAslan/promptcachelint
- Zep, "Where you put memory in the prompt can cut your token bill up to 2x" — https://blog.getzep.com/where-you-put-memory-in-the-prompt-can-cut-your-token-bill-up-to-2x/
- Mastra, Observational memory — https://mastra.ai/docs/memory/observational-memory
