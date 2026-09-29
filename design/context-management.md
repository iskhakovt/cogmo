# Context Window Management `[confirmed]`

## Problem

Conversations grow unboundedly. Each turn adds user input, assistant response, and potentially large tool results (web search, file reads). Without management, the context eventually exceeds the model's window — the API rejects the request and the conversation dies.

Even before hitting the hard limit, quality degrades. Research shows accuracy drops 30%+ for information in middle positions ("lost in the middle" effect), and task success rates decline measurably after ~35 minutes of agentic operation.

## Our Advantages

1. **Hindsight (semantic memory)** — cross-session recall via embedding search. Facts extracted by the Observer survive any in-context compression.
2. **Core memory blocks** — always injected into system prompt, survive compaction by design. What belongs there rather than in Hindsight: [memory.md](memory.md) → Core Memory vs Hindsight.
3. **Auto-recall** — relevant memories re-injected each turn. Aggressive history compression is safer because important past context is recoverable via retrieval.

These mean compaction can be more aggressive than a system without external memory — information isn't permanently lost, just moved to a different tier.

## Token Counting

`countTokens()` on the `LlmProvider` interface. Not optional — every provider must implement it. Accepts the same inputs as a chat request (system, messages, tools) and returns the token count.

| Provider | Method | Accuracy | Latency | Cost |
|----------|--------|----------|---------|------|
| Anthropic | Native `messages.countTokens()` API | Exact | 50-1700ms (scales with size) | Free |
| OpenAI-compatible | `js-tiktoken` (local) | Exact for OpenAI models | <10ms | Zero |

**Why not optional / heuristic-only:** Heuristic estimation (chars/4) has 20-40% error depending on content type. Tool definitions, images, and structured content skew heavily. Inaccurate counting leads to either premature compaction (wasted cost, cache invalidation) or late compaction (API rejection, degraded quality). Both providers have accurate, free counting methods — use them.

**Images on OpenAI-compatible routes** `[proposed]`. `countTokens` estimates each image from its dimensions with OpenAI's tile formula, or conservatively when they are unknown. A fixed low-detail figure would undercount: from Append-only step 4 every earlier image is in view ([prompt-caching.md](prompt-caching.md#sources-and-fixes) → source (d)).

**Why js-tiktoken over alternatives:** `@anthropic-ai/tokenizer` is dead (last update 2023, Claude 1/2 only — Anthropic hasn't published the Claude 3+ tokenizer). `gpt-tokenizer` is 53MB vs js-tiktoken's 22MB at identical accuracy. `tiktoken` (WASM variant) has runtime compatibility concerns. For Claude models, no local tokenizer works — the API is the only accurate option.

## Model Registry

Context window and output limits are properties of the model, not the profile. `resolveLimits` (`src/llm/models.ts`) takes each from, in order: an operator override on the routing row, LiteLLM's catalog (a live copy refreshed every six hours, then the snapshot bundled with the release), and a conservative 128k / 4k default that logs a warning. An unknown model never fails; it compacts early. See [providers.md](providers.md#limits-resolution).

## Context Budget

The budget is the maximum input tokens for a request:

```
budget = contextWindow - maxOutputTokens - safetyBuffer
```

`safetyBuffer` accounts for estimation errors and provider overhead (Anthropic adds internal system tokens). ~10K tokens — Claude Code uses ~13K.

## Persistence Model

Compaction never rewrites the database, which retains the full, unmodified conversation history. Strategy 1 is an edit intent on the request, Strategy 3 cuts the view in memory, and only Strategy 2's summary is stored ([Durable summaries](#durable-summaries-confirmed)).

- The Observer can extract facts from the complete conversation, not just the compacted view.
- Debounce cursors and message IDs are unaffected — they reference DB rows, not the compacted array.
- Strategy changes (different thresholds, different summarization prompts) take effect immediately without data migration.
- No destructive operations — the full history can always be re-derived.

The fast-path optimization (persisting `inputTokens` on assistant messages) avoids re-computing compaction on every turn without modifying the message content itself.

**An ephemeral view is still a history edit** `[confirmed]`. The next turn has to reproduce the view a turn sent, or it misses the cache and replays thinking blocks bound to a prefix it doesn't send. A turn whose Strategy 3 or unstored summary rewrote its history therefore opens a system prompt epoch and stores its head as `compacted`, so the next turn opens another. Strategy 1 runs as a request-level edit that leaves the transcript alone ([Where it runs](#strategy-1-clear-tool-results-trigger-60)), and Strategy 0 is retired ([Retirement](#retirement-confirmed)). See [prompt-caching.md](prompt-caching.md#append-only-transcript-confirmed) → Append-only Transcript.

### Durable summaries `[confirmed]`

Strategy 2 is the exception, because it is the only strategy that costs an LLM call. Recomputing it every turn would re-bill the same span of conversation indefinitely, so its output is written to `conversation_summaries` and replayed on subsequent turns.

| Column | Meaning |
|-|-|
| `conversation_id` | Owning conversation. |
| `summary` | The text, exactly as it re-enters the context. |
| `through_message_id` | Last `messages` row the summary stands in for. Snapped to a tool_use/tool_result pair boundary at write time. |
| `messages_summarized` | Real messages the summary replaced — audit trail, not a cursor. Excludes a previous summary folded in, so a re-compaction's count matches what the user was told. |
| `model` | Summarization model that produced the text. |
| `source` | `turn` (Strategy 2 fired under budget pressure) or `manual` (`/compact`). |

The table is **append-only**. Re-compaction inserts a new row summarizing the previous summary plus everything that arrived since; the loader reads the newest row per conversation. This preserves the "prefer immutable rows" rule and leaves an audit trail of how often a conversation has been compacted and by which path.

**The raw transcript is never rewritten.** `conversation_summaries` is an overlay: `loadTurnHistory` (`src/agent/conversation/load-turn-history.ts`) reads the widest summary, drops every message at or before its cutoff, and prepends the summary as one user message. It also leads each turn-starting message with the turn context it was sent with ([prompt-caching.md](prompt-caching.md) → Turn Context), so both summarization paths read the prefix as the model saw it. The Observer and the web history read keep taking the complete transcript through `listMessages`, so fact extraction is unaffected — the collapse and the turn contexts are LLM-facing only. Dropping the table restores full-history behavior with no migration.

**One bullet above no longer holds**, and it is the real cost of durability: *"strategy changes take effect immediately without data migration"* is now false for the summarization prompt and model. A stored summary is never re-derived — the raw prefix behind it is never revisited — so improving `SUMMARIZATION_PROMPT` or switching `summarizationModel` can only produce a summary *of the old summary* on spans already compacted, while the old text keeps re-entering the context verbatim. Accepted: re-deriving would mean re-billing every historical span on every prompt tweak, which is the cost the table exists to remove. If a prompt change ever needs to reach old spans, the mechanism is deleting the affected rows so the next turn re-summarizes from the transcript, which is still intact.

**Reading order is by coverage, not insertion.** `getLatestSummary` orders by `through_message_id DESC`, so the widest summary wins. The two orders agree in normal operation, since each compaction covers strictly more than the last, and diverge only when a slow `/compact` commits a narrower summary after a turn has already stored a wider one — ordering by `id` there would orphan the wider summary and silently re-include messages it already covers. The `(conversation_id, through_message_id)` unique index serves this sort scanned backwards, so it needs no second index.

**Idempotency.** `(conversation_id, through_message_id)` is UNIQUE and the write goes through `ON CONFLICT DO UPDATE` with a no-op SET. `durable: true` buys replay-safety, not exactly-once — a crash between the commit and Inngest recording the step re-runs the write — so the constraint is what keeps a retry from appending a second row for the same span. See [.claude/rules/inngest.md](../.claude/rules/inngest.md) for the shape.

**Cutoff derivation.** `loadTurnHistory` returns `messageIds` positionally aligned with the messages it hands back, `null` for the synthetic summary entry. Strategy 1 is an intent on the request, so nothing before Strategy 2 changes the array, and `messagesSummarized` indexes it directly and the cutoff is the last real id inside the summarized span. When that span holds only the previous summary, there is no cutoff to advance to and the write is skipped — re-summarizing a summary while covering nothing new is pure loss.

### Manual compaction `[confirmed]`

`/compact` forces Strategy 2 immediately, regardless of budget pressure, and stores the result. The next turn then starts from a summary it did not have to wait for. `src/agent/conversation/compact-conversation.ts` drives it synchronously — the same trade-off `/reflect` makes: the user is waiting on the reply, single-user scale means no concurrent fire to race, and errors surface to the caller instead of a retry log.

It picks the same split the budget-triggered path would (`DEFAULT_KEEP_TURNS`). `[confirmed]` It renders the prefix through the one renderer and carries that fork's Strategy 1 intent, triggered at the summarization model's budget, so a prefix that fits is summarized from the full tool results ([Strategy 2](#strategy-2-summarize-trigger-80) → Cleared results in the fork). Outside a turn there is no frozen tool table, so it strips every thinking block from its request ([prompt-caching.md](prompt-caching.md#sources-and-fixes) → source (h)). `[proposed]` Attachments render as placeholders naming the file.

Because there is no budget gate, the manual path carries a floor the automatic one does not need: below `MIN_MESSAGES_TO_COMPACT` **real messages** outside the retain window it returns `too_short` rather than paying for a call. Reaching 80% of the window on that few messages means they are individually enormous and worth summarizing; asking by hand on a short conversation is not. The floor counts messages rather than compaction-view entries, so a re-compaction can't clear it on the strength of the previous summary occupying a slot.

Outcomes: `too_short` (nothing outside the retain window, or too little to be worth a call), `nothing_new`, `empty_summary` (the model returned no text — nothing is stored), `truncated`, or the message counts. `nothing_new` also covers an already-compacted conversation, where the only thing outside the window is the stored summary — reporting that as `too_short` would tell someone their 500-message conversation is short. `truncated` is a dead end rather than a retry: the response hit its output cap, re-running feeds the same prefix into the same cap, and the input cap tracked in `todo.md` is what would let that span be compacted at all. `nothing_new` covers both ways a concurrent turn can win the race: taking the same cutoff, where the conflict arm keeps its text, or a wider one, where this row is written but coverage-ordered reads will never return it. The driver re-reads after the write, in a **separate** transaction — under REPEATABLE READ a snapshot is taken at a transaction's first statement, so a read sharing the insert's transaction would be blind to anything committed after it.

What that catches is a turn that committed before the re-read, which covers the whole summarization round trip — the window that actually matters, since it is seconds long. A turn committing *after* the re-read still supersedes the manual row, and `/compact` will have reported success. That is not a lie about the past: the row was the widest when it was checked, and the later summary is legitimately the better one. Closing it would mean holding a lock across the read, the LLM call and the write, blocking every turn in that conversation for the duration — a worse trade than a stale success message.

An empty read-back is neither outcome. The insert committed and this snapshot is taken after that commit, so seeing nothing contradicts it — `nothing_new` would say the summary was discarded and `compacted` would promise a durability the check just failed to confirm. The driver raises instead, which `/compact` surfaces as a failure the user can act on by running it again. Failures become a `compaction_failed` Transport error rather than an escaping rejection: the driver runs inline with no retry budget behind it, so a throw would otherwise leave the user's "Compacting…" ack as the last thing they see.

A `/compact` racing an in-flight turn is safe by construction: the turn froze its history inside the durable `load-turn-transcript` step, and a manual compaction only ever covers a prefix of what that turn already read.

## Strategy Pipeline

Three strategies, applied in order from gentlest to most aggressive. Each has a trigger threshold expressed as a fraction of the budget.

### Strategy 0: Same-Tool Supersession `[trigger: count-based]`

Retired, and kept as the open append-only alternative. It compacts the middle results of a same-tool cluster into one summary block once the tool's result count reaches a trigger, keeping the first and the most recent verbatim.

#### Retirement `[confirmed]`

Each time a cluster crosses its trigger, Strategy 0 rewrites a `tool_result` that later thinking blocks are bound to: a 400 where preserved thinking is enforced. It has no server-side form, and its only append-only form rewrites the span before an epoch's opening row, where a summary is about to replace those clusters anyway. Its benefit is an unmeasured argument that same-tool results dilute attention on the user's request, and Strategy 1 and Class D's volume-cluster trigger ([agent-resilience.md](agent-resilience.md#volume-cluster-trigger-confirmed)) bound the volume. Decision: retire it from turns and from `/compact`. Alternative left open: the append-only form.

The volume consequence is largest on 1M-window models. There Strategy 1 fires only past ~500k tokens, so a run of repeated reads stays verbatim far longer than Strategy 0 would have left it. If that shows up as lost quality, the lever is a lower Strategy 1 trigger (the server default is 100k tokens), not reviving Strategy 0.

### Strategy 1: Clear Tool Results `[trigger: 60%]`

Replace old `tool_result` content with a placeholder. The OpenAI-compatible adapter writes `[Cleared — call tool again if needed]`; Anthropic, clearing server-side, "replaces each cleared result with placeholder text indicating to Claude that it was removed". Keep the `tool_use` block intact so the model knows what was called and with what arguments.

- Clear oldest first
- Keep the **last K tool results** intact (default 5) — recent results are likely still relevant
- Optionally exclude specific tools whose results are persistent references

**Why first:** Tool results are typically the largest tokens in an agentic conversation (web pages, file contents, search results). Once the model has processed a result and generated its response, the raw result is redundant — the model's text captures the salient information. JetBrains and ACON research shows 95%+ accuracy preserved with 26-54% token reduction from this strategy alone. Anthropic calls it "the safest, lightest touch form of compaction."

**Cost:** Zero LLM tokens. Only KV cache invalidation cost.

**Where it runs** `[confirmed]`. As a request-level edit intent on `ChatParams`, which leaves the transcript alone; each adapter maps the intent, as with the cache intent.

- **Anthropic.** The adapter sends server-side `clear_tool_uses_20250919` (beta `context-management-2025-06-27`) on every request, which keeps the beta set constant. Its trigger is this threshold in input tokens, `keep` is 5 tool uses, and `clear_at_least` makes each clearing worth its cache write. The client keeps sending the full history, and the preserved-thinking check compares what was sent, so thinking stays valid. Clearing also runs between a turn's iterations.
- **Token counting.** `countTokens` applies the same intent on every adapter. The Anthropic endpoint returns the post-clearing count, and the count before clearing in `context_management.original_input_tokens`, which compaction's telemetry logs as its "before"; the OpenAI-compatible adapter clears locally exactly as it clears the wire body.
- **OpenAI-compatible.** The adapter applies the same clearing to the wire body. Those routes replay no reasoning, so the moving cleared set costs cache only.

### Strategy 2: Summarize `[trigger: 80%]`

LLM-summarize the conversation prefix. Keep the last K turns verbatim (default 6 — 3 user/assistant pairs).

The summarized messages are replaced with a single **user-role message** containing the summary, prefixed with `[Previous conversation summary]`.

**Summarization model:** Configurable separately from the conversation model. Using a cheaper model (e.g., Haiku) saves ~5x per compaction with acceptable quality.

**Summarization prompt** instructs the model to preserve:
- User decisions and stated preferences
- Active tasks, status, and blockers
- Exact file paths, URLs, and identifiers
- Verbatim quotes of user instructions or corrections
- Errors and their resolutions
- Facts not already captured in core memory

The summarization call receives the system prompt (or at minimum the core memory blocks) as context, so it can actually follow the "don't repeat what's in core memory" instruction.

**Why user-role message, not system injection:**
- Doesn't invalidate the system prompt cache (`cache_control: ephemeral` on system blocks is too valuable to break)
- Clean separation: system prompt = identity/rules/core memory; messages = conversation state
- Industry standard — Claude Code, Codex, LangChain, Microsoft Agent Framework all use user-role summaries

**Cost:** One LLM call per compaction (~$0.50 at Sonnet pricing for 150K tokens, ~$0.10 at Haiku pricing).

**KV cache impact:** Compaction invalidates the conversation portion of the cache — equivalent to ~21 follow-up turns at cached rates. This is why the trigger is high (80%): compact infrequently but significantly.

**Iterative compaction:** On subsequent compactions, the conversation starts with the previous summary message + newer turns. The summarization re-summarizes everything (previous summary + accumulated turns) into a fresh summary. Quality degrades compoundingly — Factory.ai data shows multi-session retention drops to ~37% after multiple compactions. Mitigation: the summarization prompt explicitly instructs verbatim preservation of key details, and Hindsight provides a recovery path for facts that drift out of the summary over time.

**Images:** `ImageBlock`s in the summarized prefix are lost — images can't be meaningfully summarized into text. If the model needs to reference an earlier image, it would need to be re-sent. This is an accepted tradeoff; images in old turns are rarely referenced again, and the alternative (carrying all images forward) defeats the purpose of compaction. `[proposed]` The summarization fork receives the span's attachments as placeholders naming the file. It renders its span from `load-turn-transcript`'s rows under that policy, over the view's index range, since nothing before Strategy 2 changes the array's length ([Durable summaries](#durable-summaries-confirmed) → Cutoff derivation): the view's resolved `image` and `document` blocks carry no path to name.

**Failure handling:** If the summarization LLM call fails (timeout, rate limit, malformed output), fall through to strategy 3 (truncation). Summarization failure should not block the conversation. Nothing is stored on that path, so the next turn re-attempts rather than inheriting a partial result.

**Durability:** the summary is persisted — see [Durable summaries](#durable-summaries-confirmed). Iterative compaction reads the stored summary back as the head of the prefix it re-summarizes, which is the same shape the in-memory path produced before the table existed.

**Fork shape** `[confirmed]`. Every summarization request, on any model, sends the `system` and `tools` the turn sends with `tool_choice: none` and appends its instruction after the prefix, so the thinking blocks it replays stay valid ([prompt-caching.md](prompt-caching.md#sources-and-fixes) → source (h)). Changing `tool_choice` invalidates the messages cache, so the fork reads only the tools and system entries. A turn that opens an epoch for another reason strips every thinking block from the fork's input, since the tools its prefix was bound to aren't stored.

**Cleared results in the fork** `[confirmed]`. The fork sends its own Strategy 1 edit intent, triggered at the summarization model's input budget, not at 60%. A prefix that fits is summarized from the full tool results; one that doesn't is cleared as the parent's is, so tool results can't push the request past the window and the summary reads placeholders only when it has to. Without an intent the fork resends every cleared result and can outgrow the window it exists to relieve; with the parent's, every summary is built from placeholders.

**Server-side alternative** `[research]`. Anthropic's on-demand compaction (`compact-2026-09-04`) returns a signed summary block behind which a kept tail's thinking stays valid, where Cogmo's own summary opens an epoch that strips it. It summarizes on the conversation's model, reading its cache; it is Anthropic-only and not on Bedrock. A stored summary would keep the block and its signature.

### Strategy 3: Truncate `[trigger: 95%]`

Emergency fallback. Drop oldest message pairs until under budget. Maintains user/assistant alternation. If the first remaining message is assistant-role, insert a synthetic user message: `[Earlier conversation history was truncated]`.

Should rarely fire if strategies 1-2 work correctly.

`[confirmed]` A turn that truncates opens a system prompt epoch, which strips the kept turns' thinking. The cut is not stored, so the next turn re-attempts the summary. While summarization keeps failing, every truncating turn opens an epoch.

### Pair-Aware Compaction `[confirmed]`

Anthropic requires every `tool_result` block (on a user message) to have a matching `tool_use` block on the immediately preceding assistant message. Both the summarize and truncate strategies respect this invariant via `snapToPairBoundary()` — if a proposed cut point would leave an orphaned `tool_result` at the start of the kept suffix, the cut snaps backward to include the preceding assistant message with the matching `tool_use`. Prefers keeping an extra pair over violating the API contract. Strategy 1 (clear tool results) replaces content with a placeholder but preserves the block structure — pairing is always intact.

**Consecutive user rows** `[confirmed]`. The persisted continuation prompt follows a user row: the turn's own or a tool-result row. `snapToPairBoundary` treats a harness-tagged row like a tool-result row, so a cut never separates it from what precedes it. The OpenAI-compatible adapter merges consecutive user messages, since strict-alternation chat templates reject them.

## Pipeline Execution

```
cutoff = attachmentCutoff(epoch, sizes)                      # [proposed] before counting: fits attachments to their budget
messages = render(rows, cutoff)                              # [proposed] attachments up to the cutoff as placeholders
edit = clearToolResults(trigger = budget * 0.60, keep = 5)   # Strategy 1: an intent every request carries

count = countTokens(system, messages, tools, edit)           # after clearing

if count > budget * 0.80:
  messages = summarize(messages, keep=6)
  count = countTokens(system, messages, tools, edit)

if count > budget * 0.95:
  messages = truncate(messages)
```

`[proposed]` The attachment cutoff comes first, so no count sends a view over the request cap ([prompt-caching.md](prompt-caching.md#sources-and-fixes) → source (d)). Every request carries Strategy 1's intent, the count included, and the adapter clears ([Where it runs](#strategy-1-clear-tool-results-trigger-60)). Strategy 0 is retired ([Retirement](#retirement-confirmed)).

**Skip-counting fast path.** `compactMessages` accepts a `skipBudgetStrategies` flag. When the caller has already decided via `shouldSkipCounting` that the turn is comfortably under the context budget, it passes `true`, and `compactMessages` returns the view unchanged without the `provider.countTokens` round-trip. Otherwise it counts once, and again only after a summary, whose size varies.

## Fast Path: Usage Tracking

Calling `countTokens` every turn adds latency. Optimization: persist both `inputTokens` and `outputTokens` from each LLM response on the assistant message row.

Before the next turn, estimate: `lastInputTokens + lastOutputTokens + newContentEstimate`. If clearly under budget (< 50%), skip `countTokens` entirely. Only long conversations pay the counting cost.

Both terms matter. The starting input for turn `N+1` is turn `N`'s input **plus** turn `N`'s output — the assistant's reply is persisted into history and becomes part of next turn's context. Tracking input alone underestimates by one response worth of tokens, which is enough to slip past the 50% threshold and skip counting when the conversation is actually close to the limit.

The estimate for new user content can use chars/4 — it only needs to be conservative enough to avoid skipping counting when the conversation is actually near the limit. New content is the user's text plus the turn's context block, recalled memories included, which no earlier request carried.

The estimate needs `inputTokens` to be the total prompt size. Anthropic's `input_tokens` counts only tokens after the last cache breakpoint, so once the transcript is cached the adapter must add the cache reads and writes back in, or the fast path sees a near-empty conversation and skips the budget strategies — see [prompt-caching.md](prompt-caching.md) → Usage Accounting.

`outputTokens` is stored `NOT NULL` with a sentinel `-1` meaning "unknown, force count" — used on the pre-migration backfill and on non-final rows in a batch insert (tool turns, user rows) that carry no meaningful output count. The fast path treats any non-negative integer as real data and any negative/null value as a force-count signal, so legacy data is always safe.

## Integration

The context manager runs in the orchestrator (`handle-message`), between loading history and calling the agent loop. This handles accumulated history across turns.

Within-turn growth (tool iterations) is bounded by `maxIterations` and the pre-flight headroom. If within-turn overflow becomes a problem in practice, the pipeline can be called between agent loop iterations too.

## User Feedback

Summarization involves an LLM call that can take several seconds on large conversations. The user should not be left waiting with no indication of what's happening.

When compaction fires, a stream event is pushed through the existing delivery pipeline before the agent loop begins. Adapters decide how to present it — Telegram might show a brief status message, a web UI might show an indicator. The event carries which strategies are being applied so adapters can tailor the message if they want.

No event is emitted for tool result clearing (instant, no user-visible delay) or emergency truncation (also instant).

## Observability

Compaction events are logged with:
- Which strategies fired (tool clearing, summarization, truncation)
- Token count before and after each strategy
- Number of tool results cleared, number of messages summarized
- Summarization model used and its token cost

This data is essential for tuning thresholds — if summarization fires too often, raise the tool-clearing threshold; if truncation fires at all, something is misconfigured.

## What This Doesn't Cover

- **Anthropic server-side compaction** (`compact_20260112`, `compact-2026-09-04`) — beta and Anthropic-only; on-demand compaction is the `[research]` alternative under [Strategy 2](#strategy-2-summarize-trigger-80).
- **Relevance-based retrieval** — embedding conversation turns and retrieving by similarity. Hindsight handles this for cross-session; within-session relevance scoring is a future enhancement.
- **Agent-directed memory** (MemGPT/Letta style) — the agent decides what to keep/evict via tool calls. Our core memory blocks are a simpler version of this.
- **Thinking block management** — Thinking blocks travel back verbatim and compaction leaves them alone, except that a turn opening a system prompt epoch drops the leading run before it ([prompt-caching.md](prompt-caching.md#system-prompt-snapshot-confirmed) → System Prompt Snapshot). `[confirmed]` Every compaction rewrite opens one ([prompt-caching.md](prompt-caching.md#append-only-transcript-confirmed) → Append-only Transcript). The Messages API rejects blocks whose content has been modified, and removing any but a leading run can trigger ordering/signature errors. There is little to reclaim in any case — `thinking.display` defaults to `omitted`, so the blocks arrive with empty text and cost almost nothing to carry. If thinking ever does create real context pressure (which would mean opting into `display: "summarized"`), the mechanism is Anthropic's server-side context editing (`clear_thinking_20251015`), not client-side rewriting.

## Industry Context

| System | Primary Strategy | Trigger | Notes |
|--------|-----------------|---------|-------|
| Claude Code | Summarization (9-section prompt) | ~89% | Re-reads recently accessed files post-compaction |
| Codex CLI | Summarization | ~90% | Retains ~20K recent tokens alongside summary |
| Gemini CLI | Summarization (2 LLM passes) | 50% | Conservative; XML state_snapshot format |
| Cursor | Summarization + file offloading | When full | Writes large tool outputs to files instead of context |
| Microsoft Agent Framework | Composable pipeline | Configurable | Same layered pattern as ours |
| Anthropic API | Server-side compaction/clearing | Configurable | `compact_20260112`, `clear_tool_uses_20250919` |
| Letta/MemGPT | Agent-directed memory tiers | ~70% | Core/recall/archival — agent manages via tool calls |

Our approach matches the Microsoft Agent Framework pattern (composable pipeline, gentlest-first) with domain-specific advantages (Hindsight integration, core memory blocks).
