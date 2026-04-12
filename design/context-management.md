# Context Window Management `[proposed]`

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

Compaction is **ephemeral** — applied in-memory when loading messages for the LLM call. The database retains the full, unmodified conversation history.

- The Observer can extract facts from the complete conversation, not just the compacted view.
- Debounce cursors and message IDs are unaffected — they reference DB rows, not the compacted array.
- Strategy changes (different thresholds, different summarization prompts) take effect immediately without data migration.
- No destructive operations — the full history can always be re-derived.

The fast-path optimization (persisting `inputTokens` on assistant messages) avoids re-computing compaction on every turn without modifying the message content itself.

## Strategy Pipeline

Three strategies, applied in order from gentlest to most aggressive. Each has a trigger threshold expressed as a fraction of the budget.

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

**Failure handling:** If the summarization LLM call fails (timeout, rate limit, malformed output), fall through to strategy 3 (truncation). Summarization failure should not block the conversation.

### Strategy 3: Truncate `[trigger: 95%]`

Emergency fallback. Drop oldest message pairs until under budget. Maintains user/assistant alternation. If the first remaining message is assistant-role, insert a synthetic user message: `[Earlier conversation history was truncated]`.

Should rarely fire if strategies 1-2 work correctly.

### Pair-Aware Compaction `[confirmed]`

Anthropic requires every `tool_result` block (on a user message) to have a matching `tool_use` block on the immediately preceding assistant message. Both the summarize and truncate strategies respect this invariant via `snapToPairBoundary()` — if a proposed cut point would leave an orphaned `tool_result` at the start of the kept suffix, the cut snaps backward to include the preceding assistant message with the matching `tool_use`. Prefers keeping an extra pair over violating the API contract. Strategy 1 (clear tool results) replaces content with a placeholder but preserves the block structure — pairing is always intact.

## Pipeline Execution

```
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

Token counting calls are minimized: one initial count, then re-count only after a strategy fires and the next threshold needs checking. Tool result clearing doesn't need a re-count (reduction is calculated from cleared content); summarization does (output size varies).

## Fast Path: Usage Tracking

Calling `countTokens` every turn adds latency. Optimization: persist `inputTokens` from each LLM response on the assistant message row.

Before the next turn, estimate: `lastInputTokens + newContentEstimate`. If clearly under budget (< 50%), skip `countTokens` entirely. Only long conversations pay the counting cost.

The estimate for new content can use chars/4 — it only needs to be conservative enough to avoid skipping counting when the conversation is actually near the limit.

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
- **Thinking block management** — Handled by `clearOldThinking()` pre-pass in the agent loop (not the compaction pipeline). Replaces thinking content with empty string in all assistant messages except the most recent. Runs unconditionally every turn — cheaper and more reliable than a budget-triggered strategy.

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
