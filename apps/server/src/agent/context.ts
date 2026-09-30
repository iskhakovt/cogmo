/**
 * Context window management — ephemeral compaction pipeline.
 *
 * Three strategies applied gentlest-first:
 * 1. Clear old tool results (60% of budget) — an edit intent every request
 *    carries, which the adapter applies ({@link toolResultClearing})
 * 2. Summarize conversation prefix (80% of budget)
 * 3. Truncate oldest messages (95% of budget)
 *
 * See design/context-management.md for full design.
 */

import type {
  ChatParams,
  ContentBlock,
  CountTokensParams,
  Message,
  ToolDefinition,
  ToolResultClearing,
} from "../llm/types.js";
import { logger } from "../logger.js";
import { validateHistory } from "./history-invariants.js";

// --- Public interface ---

export interface ContextManagerDeps {
  /** Count tokens for the given request parameters, after the clearing they ask for. */
  countTokens: (params: CountTokensParams) => Promise<number>;
  /** Maximum input tokens before rejection (contextWindow - maxOutputTokens - safetyBuffer). */
  budget: number;
  /**
   * The route's request-size cap, in bytes (`MAX_REQUEST_BYTES`). The view's
   * raw bytes past 80% of it summarize and then truncate, whatever the count
   * after clearing says.
   */
  maxRequestBytes: number;
  /**
   * Strategy 1, which every count carries: the intent the turn's requests
   * send, from {@link toolResultClearing}.
   */
  clearToolResults: ToolResultClearing;
  /**
   * Make a summarization LLM call. Receives system prompt + messages to summarize.
   *
   * Contract: called **at most once** per `compactMessages` invocation. Callers
   * (notably `handle-message`) rely on this to wrap the call in a single Inngest
   * step with a fixed step ID (`summarize-prefix-outcome`). If a future strategy ever
   * needs segmented summarization, this contract — and the hardcoded step ID at
   * the call site — must change in lockstep.
   */
  summarize?: (system: string, messages: Message[]) => Promise<string>;
  /**
   * Veto on summarizing a prefix of `splitIdx` entries, consulted after the
   * split is chosen and before the LLM call.
   *
   * Exists because worth is not a property of the prefix's shape. A one-entry
   * prefix holding a 500K-token message is the best case for Strategy 2; a
   * one-entry prefix holding a previously-stored summary is the worst, buying a
   * summary of a summary that advances no cutoff and gets discarded. Only a
   * caller holding the message ids can tell those apart, so `handle-message`
   * gates on whether the span has a durable cutoff. Omitted means no veto.
   *
   * `splitIdx` indexes the array the caller passed in, which holds because
   * nothing before summarization changes it: Strategy 1 is an intent on the
   * request. A future pre-summarize strategy that drops or merges entries has
   * to hand the split back instead.
   */
  canSummarizePrefix?: (splitIdx: number) => boolean;
}

/**
 * A compaction that rewrote the view. Counts are after Strategy 1's clearing,
 * and `null` where the view was too large in bytes to count.
 */
export interface CompactionEvent {
  strategies: ("summarize" | "truncate")[];
  tokensBefore: number | null;
  tokensAfter: number | null;
  /** The view's raw size before compaction, which the size trigger compares. */
  requestBytesBefore: number;
  messagesSummarized: number;
}

export interface CompactResult {
  messages: Message[];
  didCompact: boolean;
  event?: CompactionEvent;
}

const CLEAR_THRESHOLD = 0.6;
const SUMMARIZE_THRESHOLD = 0.8;
const TRUNCATE_THRESHOLD = 0.95;

/** Tool results Strategy 1 leaves in place, newest first. */
const DEFAULT_KEEP_TOOL_RESULTS = 5;

/**
 * The least a clearing must free, as a fraction of the budget. Clearing
 * writes the cache again from the first result it clears, and it pays for
 * that only by postponing summarization, which fires 20% of the budget
 * later: one that can't free a tenth of the budget buys little room. The
 * context-editing docs' example asks the same of its trigger, 5,000 tokens
 * of 30,000.
 */
const CLEAR_AT_LEAST = 0.1;

/**
 * Strategy 1's edit intent for a turn with `budget` input tokens: clear the
 * oldest tool results once the prompt passes 60% of the budget, keeping the
 * last five. Every request of the turn carries it, forks and counts included,
 * and the adapter clears (see `ToolResultClearing`); the transcript itself is
 * never rewritten.
 */
export function toolResultClearing(budget: number): ToolResultClearing {
  return {
    triggerTokens: Math.floor(budget * CLEAR_THRESHOLD),
    keep: DEFAULT_KEEP_TOOL_RESULTS,
    clearAtLeastTokens: Math.floor(budget * CLEAR_AT_LEAST),
  };
}

/**
 * Messages kept verbatim after the summarized prefix. Exported because the
 * manual `/compact` driver forces the same split the 80%-budget strategy would
 * have chosen, and a divergence there would make a manual compaction and an
 * automatic one cover different spans of the same conversation.
 */
export const DEFAULT_KEEP_TURNS = 6;

export const SUMMARIZATION_PROMPT = `Summarize the conversation below. You MUST preserve:
1. All user decisions and stated preferences
2. Active tasks, their status, and any blockers
3. Exact file paths, URLs, and identifiers referenced
4. Verbatim quotes of user instructions or corrections
5. Errors encountered and their resolutions
6. Any facts not already captured in the system prompt or core memory

Focus on what the assistant needs to continue the conversation.
Be specific — preserve names, paths, and values, not abstractions.`;

/**
 * The summarization request both compaction paths send. Shared so the prompt,
 * the output cap and the message layout cannot drift between the turn-time
 * strategy and the manual `/compact` driver.
 *
 * The prefix is repaired first, through the same `validateHistory` the agent
 * loop applies to every request — so the summarizer reads the shape the model
 * reads. That is also why a repair here cannot lose anything: a stray
 * `tool_result` dropped from the prefix was already dropped from every LLM
 * payload by `sanitizeHistory`, and the row itself stays in `messages` for the
 * Observer. `sanitizeHistory` runs inside the agent loop,
 * which is downstream of compaction, so a summarization request is the one
 * LLM call in a turn built from raw history — and a split can land right after
 * an assistant `tool_use` that history never answered, which Anthropic rejects
 * outright. Unrepaired, that 400 is permanent for the conversation: the manual
 * path surfaces it as `compaction_failed` on every attempt, and the turn-time
 * path swallows it into a wasted billable call plus a silent drop to
 * truncation on every turn above the threshold.
 *
 * The cap leaves room for reasoning as well as the summary, bounded by what
 * this model accepts — asking above its ceiling is a 400 of a different kind.
 */
export function summarizationRequest(params: {
  model: string;
  system: string;
  messages: ReadonlyArray<Message>;
  maxOutputTokens: number;
  /**
   * The turn's Strategy 1 intent, so the summarizer reads the prefix cleared
   * as the turn's requests read it. `/compact`, outside a turn, sends none.
   */
  clearToolResults?: ToolResultClearing;
}): ChatParams {
  const { messages: repaired, repairs } = validateHistory(params.messages);
  if (repairs.length > 0) {
    // `validateHistory` leaves telemetry to the caller, and `sanitizeHistory`
    // is the only other one. `/compact` never reaches the agent loop, so
    // without this a manually-compacted conversation repairs its orphans
    // silently — and folds them into a summary that is never re-derived.
    logger.warn({ repairCount: repairs.length, repairs }, "repaired summarization prefix");
  }
  return {
    model: params.model,
    system: params.system,
    messages: [...repaired, { role: "user", content: SUMMARIZATION_PROMPT }],
    maxTokens: Math.min(16_000, params.maxOutputTokens),
    ...(params.clearToolResults && { clearToolResults: params.clearToolResults }),
  };
}

/**
 * Concatenate the text blocks of a summarization response. Non-text blocks
 * (thinking, and anything a future model emits alongside prose) are dropped —
 * only the prose stands in for the conversation.
 *
 * Joined on a paragraph break. Blocks in a non-streaming response are discrete
 * units rather than fragments of one, so that is the seam that cannot corrupt
 * the text — and this text is stored and replayed rather than recomputed, so a
 * fused sentence would be permanent. One block is the expected case
 * (`fromOpenAIMessage` emits at most one; Anthropic returns several only when
 * they are interleaved with `tool_use`, which a summarization request never
 * carries), which is why more than one is worth a log line.
 */
export function extractSummaryText(content: ReadonlyArray<ContentBlock>): string {
  const text = content.filter((b) => b.type === "text");
  if (text.length > 1) {
    // The request carries no tools, so more than one block means an assumption
    // in the docblock above has moved.
    logger.warn(
      { blocks: text.length },
      "summarization returned multiple text blocks; joined on a paragraph break",
    );
  }
  return text.map((b) => b.text).join("\n\n");
}

/**
 * Render a summary as the single user message that stands in for the span it
 * replaces. One definition serves both the in-memory pipeline and the durable
 * replay of a persisted summary, so a stored summary re-enters the context in
 * exactly the shape the model saw when it was produced.
 */
export function formatSummaryMessage(summary: string): Message {
  return { role: "user", content: `[Previous conversation summary]\n\n${summary}` };
}

/**
 * Run the compaction pipeline on conversation messages. Returns the
 * (possibly compacted) messages and metadata about what was applied.
 *
 * Every count carries Strategy 1's intent, so each is the prompt after
 * clearing, and the view comes back unchanged unless Strategy 2 or 3 rewrote
 * it. Both fire on budget pressure: callers that know the turn is comfortably
 * under budget (via `shouldSkipCounting`) skip the `countTokens` round-trip by
 * passing `skipBudgetStrategies`.
 *
 * They also fire on size. The server clears after the request arrives, so the
 * request carries every result and its bytes can reach the route's cap long
 * before the count after clearing reaches the budget. A view past 80% of the
 * cap summarizes on any path, without a count, since counting it sends it;
 * one the summary leaves past that, truncates until it fits.
 */
export async function compactMessages(
  system: string,
  messages: ReadonlyArray<Message>,
  tools: ToolDefinition[] | undefined,
  deps: ContextManagerDeps,
  skipBudgetStrategies = false,
): Promise<CompactResult> {
  const { countTokens, budget, summarize, clearToolResults, maxRequestBytes } = deps;
  const oversized = (msgs: ReadonlyArray<Message>): boolean =>
    requestBytes(system, msgs, tools) > maxRequestBytes * SUMMARIZE_THRESHOLD;
  if (skipBudgetStrategies && !oversized(messages)) {
    return { messages: [...messages], didCompact: false };
  }

  const strategies: CompactionEvent["strategies"] = [];
  let result = [...messages];
  let messagesSummarized = 0;
  const requestBytesBefore = requestBytes(system, result, tools);

  const count = (msgs: Message[]): Promise<number | null> =>
    oversized(msgs)
      ? Promise.resolve(null)
      : countTokens({
          model: "",
          system,
          messages: msgs,
          clearToolResults,
          ...(tools && { tools }),
        });

  let tokens = await count(result);
  const tokensBefore = tokens;

  // Strategy 2: Summarize conversation prefix at 80%, of the budget or the size cap
  if ((tokens === null || tokens > budget * SUMMARIZE_THRESHOLD) && summarize) {
    try {
      const summarized = await summarizePrefix(
        result,
        system,
        summarize,
        DEFAULT_KEEP_TURNS,
        deps.canSummarizePrefix,
      );
      if (summarized.summarizedCount > 0) {
        result = summarized.messages;
        messagesSummarized = summarized.summarizedCount;
        strategies.push("summarize");
        tokens = await count(result);
      }
    } catch (err) {
      logger.warn({ err }, "summarization failed, falling through to truncation");
    }
  }

  // Strategy 3: Emergency truncation at 95% of the budget, or until the view fits the size cap
  if (tokens === null || tokens > budget * TRUNCATE_THRESHOLD) {
    result = truncateOldest(result);
    while (oversized(result)) {
      const next = truncateOldest(result);
      if (next.length >= result.length) break;
      result = next;
    }
    strategies.push("truncate");
    tokens = await count(result);
  }

  if (strategies.length > 0) {
    const event: CompactionEvent = {
      strategies,
      tokensBefore,
      tokensAfter: tokens,
      requestBytesBefore,
      messagesSummarized,
    };
    logger.info(event, "context compaction applied");
    return { messages: result, didCompact: true, event };
  }
  return { messages: result, didCompact: false };
}

/**
 * The request's raw size as the view holds it: every tool result and
 * attachment, before any clearing. The adapter's wire format differs by a few
 * key names, which the 20% margin under the cap absorbs.
 */
function requestBytes(
  system: string,
  messages: ReadonlyArray<Message>,
  tools: ToolDefinition[] | undefined,
): number {
  return Buffer.byteLength(JSON.stringify({ system, messages, tools }));
}

/**
 * Fast-path check: should we skip the expensive countTokens call?
 * Returns true if the conversation is clearly under budget.
 *
 * Starting input for the *next* turn is:
 *   prev input + prev output + new user content
 * because the assistant's reply is persisted into history. Leaving the output
 * term out biases the estimate low by one response — enough to slip past the
 * 50% threshold and skip counting when we shouldn't.
 *
 * `null` (no prior assistant row) or a negative sentinel (pre-migration /
 * row not carrying a real count) on either field means "unknown" → force a
 * real count.
 */
export function shouldSkipCounting(
  lastInputTokens: number | null,
  lastOutputTokens: number | null,
  newContentChars: number,
  budget: number,
): boolean {
  if (lastInputTokens === null || lastInputTokens < 0) return false;
  if (lastOutputTokens === null || lastOutputTokens < 0) return false;
  const estimate = lastInputTokens + lastOutputTokens + Math.ceil(newContentChars / 4);
  return estimate < budget * 0.5;
}

// --- Internal strategies ---

async function summarizePrefix(
  messages: Message[],
  system: string,
  summarize: (system: string, messages: Message[]) => Promise<string>,
  keepTurns: number,
  canSummarize: ContextManagerDeps["canSummarizePrefix"],
): Promise<{ messages: Message[]; summarizedCount: number }> {
  // Keep the last keepTurns messages (user/assistant pairs)
  const rawSplit = Math.max(0, messages.length - keepTurns);
  if (rawSplit <= 0) return { messages, summarizedCount: 0 };

  const splitIdx = snapToPairBoundary(messages, rawSplit);
  if (splitIdx <= 0) return { messages, summarizedCount: 0 };
  // See `ContextManagerDeps.canSummarizePrefix` for why the caller decides.
  if (canSummarize && !canSummarize(splitIdx)) return { messages, summarizedCount: 0 };

  const prefix = messages.slice(0, splitIdx);
  const suffix = messages.slice(splitIdx);

  const summary = await summarize(system, prefix);

  // The summary replaces `prefix` entirely, so an empty one would leave
  // the header below standing in for that whole span of the conversation.
  // Reporting "summarized nothing" leaves the messages alone — the
  // caller's own convention — and emergency truncation still gets its
  // turn. Reachable when the summarization model spends its budget
  // reasoning and returns no text.
  if (summary.trim().length === 0) {
    logger.warn(
      { prefixLength: prefix.length },
      "summarization returned no text — keeping the prefix and falling through to truncation",
    );
    return { messages, summarizedCount: 0 };
  }

  const summaryMessage = formatSummaryMessage(summary);

  return {
    messages: [summaryMessage, ...suffix],
    summarizedCount: prefix.length,
  };
}

function truncateOldest(messages: Message[]): Message[] {
  // Drop the oldest 30% of messages. This is a rough heuristic — the pipeline
  // re-counts after truncation, so overshooting is harmless (just drops a bit more).
  // Undershooting is caught by the re-count triggering another pass next turn.
  const dropCount = Math.max(
    0,
    Math.min(Math.max(Math.ceil(messages.length * 0.3), 2), messages.length - 2),
  );
  const snapped = Math.max(0, snapToPairBoundary(messages, dropCount));
  const result = messages.slice(snapped);

  // Ensure alternation — first message must be user role
  if (result.length > 0 && result[0]?.role !== "user") {
    result.unshift({
      role: "user",
      content: "[Earlier conversation history was truncated]",
    });
  }

  return result;
}

// --- Pair-aware helpers ---

function hasToolResults(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return false;
  return content.some((b) => b.type === "tool_result");
}

/**
 * Adjust a split index so the suffix (messages[idx:]) never starts with
 * orphaned tool_result blocks. Snaps backward to include the preceding
 * assistant message that produced the tool_uses.
 *
 * Used by both summarize (snap = summarize less, keep more) and truncate
 * (snap = drop less, keep more) — both prefer keeping an extra pair over
 * violating Anthropic's pairing invariant.
 */
export function snapToPairBoundary(messages: ReadonlyArray<Message>, splitIdx: number): number {
  let idx = splitIdx;
  while (idx > 0 && idx < messages.length) {
    const msg = messages[idx];
    if (msg && msg.role === "user" && hasToolResults(msg.content)) {
      idx--;
    } else {
      break;
    }
  }
  return idx;
}
