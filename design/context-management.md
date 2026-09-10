# Context Window Management `[confirmed]`

## Problem

Conversations grow unboundedly. Each turn adds user input, assistant response, and potentially large tool results (web search, file reads). Without management, the context eventually exceeds the model's window — the API rejects the request and the conversation dies.

Even before hitting the hard limit, quality degrades. Research shows accuracy drops 30%+ for information in middle positions ("lost in the middle" effect), and task success rates decline measurably after ~35 minutes of agentic operation.

## Our Advantages

1. **Hindsight (semantic memory)** — cross-session recall via embedding search. Facts extracted by the Observer survive any in-context compression.
2. **Core memory blocks** — always injected into system prompt, survive compaction by design.
3. **Auto-recall** — relevant memories re-injected each turn. Aggressive history compression is safer because important past context is recoverable via retrieval.

These mean compaction can be more aggressive than a system without external memory — information isn't permanently lost, just moved to a different tier.

## Token Counting

`countTokens()` on the `LlmProvider` interface. Not optional — every provider must implement it. Accepts the same inputs as a chat request (system, messages, tools) and returns the token count.

| Provider | Method | Accuracy | Latency | Cost |
|----------|--------|----------|---------|------|
| Anthropic | Native `messages.countTokens()` API | Exact | 50-1700ms (scales with size) | Free |
| OpenAI-compatible | `js-tiktoken` (local) | Exact for OpenAI models | <10ms | Zero |

**Why not optional / heuristic-only:** Heuristic estimation (chars/4) has 20-40% error depending on content type. Tool definitions, images, and structured content skew heavily. Inaccurate counting leads to either premature compaction (wasted cost, cache invalidation) or late compaction (API rejection, degraded quality). Both providers have accurate, free counting methods — use them.

**Why js-tiktoken over alternatives:** `@anthropic-ai/tokenizer` is dead (last update 2023, Claude 1/2 only — Anthropic hasn't published the Claude 3+ tokenizer). `gpt-tokenizer` is 53MB vs js-tiktoken's 22MB at identical accuracy. `tiktoken` (WASM variant) has runtime compatibility concerns. For Claude models, no local tokenizer works — the API is the only accurate option.

## Model Registry

Context window and output limits are properties of the model, not the profile. A model registry maps model identifiers to capabilities (context window size, max output tokens).

Known models are listed explicitly. Unknown models **fail with a clear error** — no guessing, no silent fallback to conservative defaults. Misconfiguration should be caught at startup, not discovered mid-conversation.

**Registry scope:** Only models we actually use. Not an exhaustive catalog. Adding a model to a profile requires adding it to the registry.

## Context Budget

The budget is the maximum input tokens for a request:

```
budget = contextWindow - maxOutputTokens - safetyBuffer
```

`safetyBuffer` accounts for estimation errors and provider overhead (Anthropic adds internal system tokens). ~10K tokens — Claude Code uses ~13K.

## Persistence Model

Compaction is **ephemeral** for Strategies 0, 1 and 3 — applied in-memory when loading messages for the LLM call. The database retains the full, unmodified conversation history.

- The Observer can extract facts from the complete conversation, not just the compacted view.
- Debounce cursors and message IDs are unaffected — they reference DB rows, not the compacted array.
- Strategy changes (different thresholds, different summarization prompts) take effect immediately without data migration.
- No destructive operations — the full history can always be re-derived.

The fast-path optimization (persisting `inputTokens` on assistant messages) avoids re-computing compaction on every turn without modifying the message content itself.

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

**The raw transcript is never rewritten.** `conversation_summaries` is an overlay: `loadTurnHistory` (`src/agent/conversation/load-turn-history.ts`) reads the widest summary, drops every message at or before its cutoff, and prepends the summary as one user message. The Observer and the web history read keep taking the complete transcript through `listMessages`, so fact extraction is unaffected — the collapse is LLM-facing only. Dropping the table restores full-history behavior with no migration.

**One bullet above no longer holds**, and it is the real cost of durability: *"strategy changes take effect immediately without data migration"* is now false for the summarization prompt and model. A stored summary is never re-derived — the raw prefix behind it is never revisited — so improving `SUMMARIZATION_PROMPT` or switching `summarizationModel` can only produce a summary *of the old summary* on spans already compacted, while the old text keeps re-entering the context verbatim. Accepted: re-deriving would mean re-billing every historical span on every prompt tweak, which is the cost the table exists to remove. If a prompt change ever needs to reach old spans, the mechanism is deleting the affected rows so the next turn re-summarizes from the transcript, which is still intact.

**Reading order is by coverage, not insertion.** `getLatestSummary` orders by `through_message_id DESC`, so the widest summary wins. The two orders agree in normal operation, since each compaction covers strictly more than the last, and diverge only when a slow `/compact` commits a narrower summary after a turn has already stored a wider one — ordering by `id` there would orphan the wider summary and silently re-include messages it already covers. The `(conversation_id, through_message_id)` unique index serves this sort scanned backwards, so it needs no second index.

**Idempotency.** `(conversation_id, through_message_id)` is UNIQUE and the write goes through `ON CONFLICT DO UPDATE` with a no-op SET. `durable: true` buys replay-safety, not exactly-once — a crash between the commit and Inngest recording the step re-runs the write — so the constraint is what keeps a retry from appending a second row for the same span. The `DO UPDATE` shape (rather than `DO NOTHING`) is required by the project's REPEATABLE READ default; see [.claude/rules/inngest.md](../.claude/rules/inngest.md).

**Cutoff derivation.** `loadTurnHistory` returns `messageIds` positionally aligned with the messages it hands back, `null` for the synthetic summary entry. Strategies 0 and 1 rewrite block content in place and never change the array's length, so `messagesSummarized` indexes that array directly and the cutoff is the last real id inside the summarized span. When that span holds only the previous summary, there is no cutoff to advance to and the write is skipped — re-summarizing a summary while covering nothing new is pure loss.

### Manual compaction `[confirmed]`

`/compact` forces Strategy 2 immediately, regardless of budget pressure, and stores the result. The next turn then starts from a summary it did not have to wait for. `src/agent/conversation/compact-conversation.ts` drives it synchronously — the same trade-off `/reflect` makes: the user is waiting on the reply, single-user scale means no concurrent fire to race, and errors surface to the caller instead of a retry log.

It picks the same split the budget-triggered path would (`DEFAULT_KEEP_TURNS`) and runs Strategy 0 over the prefix first, matching that ladder's first rung — count-based and structural, so it needs no token count. It does **not** run Strategy 1: clearing tool results would have the summarizer read placeholders instead of the output it is meant to compress, and unlike the turn-time path there is no budget pressure to justify that loss.

Because there is no budget gate, the manual path carries a floor the automatic one does not need: below `MIN_MESSAGES_TO_COMPACT` **real messages** outside the retain window it returns `too_short` rather than paying for a call. Reaching 80% of the window on that few messages means they are individually enormous and worth summarizing; asking by hand on a short conversation is not. The floor counts messages rather than compaction-view entries, so a re-compaction can't clear it on the strength of the previous summary occupying a slot.

**Strategy 2's input differs between the paths, and the turn-time one is the weaker.** Strategy 1 fires at 60% and Strategy 2 at 80%, so by the time the turn-time summarizer runs, every tool result outside the most recent five is already a `[Cleared — call tool again if needed]` placeholder — and that is now what gets frozen into a durable summary. `/compact` skips Strategy 1 for exactly this reason and reads the real output. Correcting it means summarizing from the pre-clear array (the strategies are length-preserving, so the indices still line up), which raises the summarization request size and is therefore coupled to the prefix-vs-window gap tracked in `todo.md`; the two want fixing together.

Outcomes: `too_short`, `nothing_new`, `empty_summary` (the model returned no text — nothing is stored), or the message counts. `nothing_new` covers both ways a concurrent turn can win the race: taking the same cutoff, where the conflict arm keeps its text, or a wider one, where this row is written but coverage-ordered reads will never return it. The driver re-reads after the write, in a **separate** transaction — under REPEATABLE READ a snapshot is taken at a transaction's first statement, so a read sharing the insert's transaction would be blind to anything committed after it.

What that catches is a turn that committed before the re-read, which covers the whole summarization round trip — the window that actually matters, since it is seconds long. A turn committing *after* the re-read still supersedes the manual row, and `/compact` will have reported success. That is not a lie about the past: the row was the widest when it was checked, and the later summary is legitimately the better one. Closing it would mean holding a lock across the read, the LLM call and the write, blocking every turn in that conversation for the duration — a worse trade than a stale success message. Failures become a `compaction_failed` Transport error rather than an escaping rejection: the driver runs inline with no retry budget behind it, so a throw would otherwise leave the user's "Compacting…" ack as the last thing they see.

A `/compact` racing an in-flight turn is safe by construction: the turn froze its history inside the durable `load-turn-history` step, and a manual compaction only ever covers a prefix of what that turn already read.

## Strategy Pipeline

Three strategies, applied in order from gentlest to most aggressive. Each has a trigger threshold expressed as a fraction of the budget.

### Strategy 0: Same-Tool Supersession `[trigger: count-based] [confirmed]`

The three strategies below are **budget-pressure-triggered** — they fire when the conversation approaches the context limit. They do not fire when a single turn calls the same tool many times at low overall budget utilization: eight `generate_image` results at 30% of the budget evade Strategy 1 entirely.

Volume-driven attention dilution is independent of budget utilization. Every same-tool `tool_result` block in the window dilutes the softmax weight on the original user intent, and the lost-in-the-middle effect compounds as same-tool results stack. The fix is **count-based**, not budget-based: when a new same-tool result lands and the total same-tool result count exceeds the trigger threshold, rewrite the now-middle results in place.

Three distinct parameters drive the strategy. Keeping the trigger and the retain knobs as separate symbols matters — collapsing them makes it impossible to set a trigger that fires only when there's enough to compact for the cache-invalidation cost to be worthwhile:

| Parameter | Default | Meaning |
|-|-|-|
| `retainRecent` | 2 | Most recent K same-tool results stay verbatim. |
| `retainFirst` | 1 | First same-tool result stays verbatim (sticky — see below). |
| `triggerCount` | 5 | Strategy fires when current same-tool count (including the just-arrived result) reaches this. Derivation: `retainRecent + retainFirst + 2` — fires when at least 2 results would be compacted, making the cache-invalidation cost worthwhile. |

At the first-fire boundary (count = 5): layout becomes `[R1, summary(R2,R3), R4, R5]` — 3 verbatim, 2 compacted into one summary block. Lower trigger values would compact 1 result per fire, eating cache invalidation for marginal attention savings; higher values let dilution accumulate longer than necessary. The default is the smallest trigger that compacts a worthwhile cluster on first fire.

This strategy is intentionally narrower than Strategy 1:

| | Strategy 0 | Strategy 1 |
|-|-|-|
| Trigger | New same-tool `tool_result` brings count > K | Total context > 60% budget |
| Scope | One tool's cluster | All old `tool_result` blocks |
| Action | Compact prior same-tool results into one summary block | Replace tool_result content with placeholder |
| Frequency | Per-turn, fires often on tool-heavy turns | Per-turn, fires only as context fills |

#### Rewrite at supersession points only

The cardinal rule is **deterministic supersession**, not continuous editing. Mutating tool_results on every turn invalidates Anthropic's prompt cache on every call — roughly 10× the input cost and ~3× the latency. Strategy 0 mutates only when a new tool_result of the same name lands; the cut point is the **new tool call's position**, not arbitrary. Older same-tool results past that boundary become eligible for compaction in a single rewrite pass; once compacted, they stay compacted across subsequent turns.

#### What stays verbatim

- The **most recent `retainRecent` results per tool** — the model leans hardest on these.
- The **first result per tool's series — sticky** (see below).
- All **non-same-tool blocks** between same-tool blocks — assistant text and other tool calls are not subject to this strategy.

**First-per-series is sticky.** Once the original first same-tool result is identified, its message-array position is preserved verbatim across all subsequent compactions. Later passes never re-evaluate which result counts as "first" — they grow the summary block in the middle. This is what the lost-in-the-middle argument actually demands: the *original* inflection point ("the model decided to start querying X") carries the planning signal, not whichever result happens to survive after compaction. Recomputing "first" on each pass — naive re-application of the rule — would let compaction creep into the original first slot over time, eroding the very signal the rule preserves.

Cache-prefix consequence: the prefix `[user turn, system prompt, …, first same-tool result + its tool_use pair]` stays stable across all compactions of this tool. The summary block sitting between the first and the recent-K is rewritten on each fire, so cache *past* that position invalidates — accepted trade-off because the high-attention prefix slot is preserved. The cache invariance argument applies to everything *up to* the first sticky result, not to the whole `[first, summary]` prefix.

Prior same-tool results between the first and the last `retainRecent` get compacted into a single block of the form:

```
[Earlier this turn: 4 prior `web_search` results — first at iteration 2 ("react testing libraries"), then "vitest jest comparison", "react testing library setup", "jest deprecation"; combined ~3.2KB. Latest 2 verbatim below.]
```

The summary preserves: count, tool name, original arg-shape per call (so the model's reasoning trace stays coherent), approximate aggregate size. It does **not** carry the result content — that's what the verbatim recent K is for.

#### Pair-aware

`tool_result` blocks must pair with `tool_use` blocks on the preceding assistant message (the existing pairing invariant; see "Pair-Aware Compaction" below). Strategy 0 rewrites the `tool_result` content into the summary block but leaves the `tool_use` blocks intact. The conversation transcript still records *what* the model called and with *what args*; only the *result content* is compacted. This matches Strategy 1's invariant.

#### Size gate

The summary string is template-derived and roughly ~150–250 chars. For tools that return verbose payloads (`web_search`, `read_file`, `fetch_url`) this is much smaller than what it replaces. But a write-style tool returning a one-byte `"ok"` would be *grown* by compaction. Strategy 0 guards against this with a per-cluster size gate: if the aggregate byte length of the middle slice is less than `middleCount × summaryLen`, the cluster is skipped. This preserves the "doesn't increase token count" invariant for the tool surfaces Strategy 0 actually targets, without baking surface-specific exceptions into the policy. The gate also makes the strategy idempotent in a stronger sense — even when content is grown by an exotic tool result we'd never see today, the array doesn't bloat across passes.

#### No-op idempotence

On the second invocation against an already-compacted array, the per-block apply pass compares the planned summary against the existing `tool_result.content`. When they're byte-identical (the steady state after the first fire), no rewrite happens, `resultsCompacted` stays at 0, and downstream telemetry (`didCompact`) doesn't flip every turn. The cluster count likewise reflects only clusters that produced an actual rewrite this pass.

#### Failure mode and rollback

If summary generation needs an LLM call (it shouldn't — the summary is template-based and cheap), Strategy 0 falls through to "leave the cluster alone, let Strategy 1 handle it on the next budget check." Strategy 0 is best-effort optimization; it never blocks a turn.

#### Where it runs

In the same load-time compaction pipeline as Strategies 1–3, applied **before** Strategy 1. Strategy 0 reduces same-tool clutter; Strategy 1 then operates on a cleaner array if budget pressure additionally calls for it.

#### Confidence

Structural shape (supersession-triggered, in-place rewrite, prior-results-only) is `[confirmed]` — that's the design constraint and the implementation matches. The numeric defaults (`retainRecent: 2`, `retainFirst: 1`, `triggerCount: 5`) remain tunable; real data on attention dilution would justify revising them, but the shape stays the same.

### Strategy 1: Clear Tool Results `[trigger: 60%]`

Replace old `tool_result` content with a placeholder (`[Cleared — call tool again if needed]`). Keep the `tool_use` block intact so the model knows what was called and with what arguments.

- Walk messages oldest → newest, clearing until under budget
- Keep the **last K tool results** intact (default 5) — recent results are likely still relevant
- Optionally exclude specific tools whose results are persistent references

**Why first:** Tool results are typically the largest tokens in an agentic conversation (web pages, file contents, search results). Once the model has processed a result and generated its response, the raw result is redundant — the model's text captures the salient information. JetBrains and ACON research shows 95%+ accuracy preserved with 26-54% token reduction from this strategy alone. Anthropic calls it "the safest, lightest touch form of compaction."

**Cost:** Zero LLM tokens. Only KV cache invalidation cost.

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

**Images:** `ImageBlock`s in the summarized prefix are lost — images can't be meaningfully summarized into text. If the model needs to reference an earlier image, it would need to be re-sent. This is an accepted tradeoff; images in old turns are rarely referenced again, and the alternative (carrying all images forward) defeats the purpose of compaction.

**Failure handling:** If the summarization LLM call fails (timeout, rate limit, malformed output), fall through to strategy 3 (truncation). Summarization failure should not block the conversation. Nothing is stored on that path, so the next turn re-attempts rather than inheriting a partial result.

**Durability:** the summary is persisted — see [Durable summaries](#durable-summaries-confirmed). Iterative compaction reads the stored summary back as the head of the prefix it re-summarizes, which is the same shape the in-memory path produced before the table existed.

### Strategy 3: Truncate `[trigger: 95%]`

Emergency fallback. Drop oldest message pairs until under budget. Maintains user/assistant alternation. If the first remaining message is assistant-role, insert a synthetic user message: `[Earlier conversation history was truncated]`.

Should rarely fire if strategies 1-2 work correctly.

### Pair-Aware Compaction `[confirmed]`

Anthropic requires every `tool_result` block (on a user message) to have a matching `tool_use` block on the immediately preceding assistant message. Both the summarize and truncate strategies respect this invariant via `snapToPairBoundary()` — if a proposed cut point would leave an orphaned `tool_result` at the start of the kept suffix, the cut snaps backward to include the preceding assistant message with the matching `tool_use`. Prefers keeping an extra pair over violating the API contract. Strategy 1 (clear tool results) replaces content with a placeholder but preserves the block structure — pairing is always intact.

## Pipeline Execution

```
messages = compactSameToolClusters(messages, retainRecent=2, retainFirst=1, triggerCount=5)   # Strategy 0 (count-based)

count = countTokens(system, messages, tools)

if count > budget * 0.60:
  messages = clearToolResults(messages, keep=5)

if count > budget * 0.80:
  count = countTokens(system, messages, tools)
  if count > budget * 0.80:
    messages = summarize(messages, keep=6)

if count > budget * 0.95:
  count = countTokens(system, messages, tools)
  if count > budget * 0.95:
    messages = truncate(messages)
```

Strategy 0 is a count-based deterministic transform — no token-count threshold, no LLM call — so its **check** runs unconditionally at the top of every turn. The **mutation** only fires when the per-tool same-tool count reaches `triggerCount` *and* the summary would shrink the aggregate bytes of the middle slice (the size gate, see "Pair-aware" below). Most turns the check finds no cluster over threshold and returns the message array unchanged. Per-turn overhead is dominated by the O(N) scan over messages — negligible at conversation scale. With the size gate in place, the transform doesn't increase total token count, so subsequent threshold checks remain correct.

**Skip-counting fast path.** `compactMessages` accepts a `skipBudgetStrategies` flag. When the caller has already decided via `shouldSkipCounting` that the turn is comfortably under the context budget, it passes `true` — `compactMessages` still runs Strategy 0 (cheap, no `countTokens` call) but skips Strategies 1–3 entirely. This preserves Strategy 0's design intent ("runs every turn regardless of budget headroom") while keeping the fast-path's avoidance of the expensive `provider.countTokens` round-trip.

Token counting calls are minimized: one initial count after Strategy 0, then re-count only after a strategy fires and the next threshold needs checking. Tool result clearing doesn't need a re-count (reduction is calculated from cleared content); summarization does (output size varies).

## Fast Path: Usage Tracking

Calling `countTokens` every turn adds latency. Optimization: persist both `inputTokens` and `outputTokens` from each LLM response on the assistant message row.

Before the next turn, estimate: `lastInputTokens + lastOutputTokens + newContentEstimate`. If clearly under budget (< 50%), skip `countTokens` entirely. Only long conversations pay the counting cost.

Both terms matter. The starting input for turn `N+1` is turn `N`'s input **plus** turn `N`'s output — the assistant's reply is persisted into history and becomes part of next turn's context. Tracking input alone underestimates by one response worth of tokens, which is enough to slip past the 50% threshold and skip counting when the conversation is actually close to the limit.

The estimate for new user content can use chars/4 — it only needs to be conservative enough to avoid skipping counting when the conversation is actually near the limit.

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

- **Anthropic server-side compaction** (`compact_20260112`) — powerful but beta and Anthropic-only. Our pipeline is provider-agnostic. Can layer server-side APIs on top later.
- **Relevance-based retrieval** — embedding conversation turns and retrieving by similarity. Hindsight handles this for cross-session; within-session relevance scoring is a future enhancement.
- **Agent-directed memory** (MemGPT/Letta style) — the agent decides what to keep/evict via tool calls. Our core memory blocks are a simpler version of this.
- **Thinking block management** — Not ours to do. Thinking blocks travel back to the provider exactly as the model emitted them: the Messages API rejects blocks whose content has been modified, and stripping them can trigger ordering/signature errors. So the loop forwards history verbatim, and the compaction pipeline leaves thinking blocks alone. There is little to reclaim in any case — `thinking.display` defaults to `omitted`, so the blocks arrive with empty text and cost almost nothing to carry. If thinking ever does create real context pressure (which would mean opting into `display: "summarized"`), the mechanism is Anthropic's server-side context editing (`clear_thinking_20251015`), not client-side rewriting.

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
