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

import * as R from "remeda";
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
  /**
   * Count tokens for the given request parameters, after the clearing they ask
   * for. Compaction tells counts apart only up to the budget, so it asks for
   * none past it (`countUpTo`).
   */
  countTokens: (params: CountTokensParams) => Promise<number>;
  /** Maximum input tokens before rejection (contextWindow - maxOutputTokens - safetyBuffer). */
  budget: number;
  /**
   * The most a view's canonical JSON may weigh, in bytes (`MAX_VIEW_BYTES`).
   * A view past 80% of it summarizes, then takes the first of
   * {@link truncations} within 80%, else the first within the cap. It goes as
   * it is when no cut would fit it better: it is within the cap and its
   * smallest cut is still past 80%, or its smallest cut is past the cap too.
   */
  maxViewBytes: number;
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
 * `null` where the view was too large in bytes to count, and, past the budget,
 * a figure past it where the adapter counts locally.
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
 * The least a clearing must free, as a fraction of the budget: half the room
 * between the clearing and summarization thresholds, since a clearing writes
 * the cache again from the first result it clears (see
 * design/context-management.md → Strategy 1).
 */
const CLEAR_AT_LEAST = 0.1;

/**
 * Strategy 1's edit intent for a turn with `budget` input tokens: once the
 * prompt passes 60% of the budget, clear every tool result but the last five,
 * provided they free a tenth of it. Every request of the turn carries it.
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
   * The turn's Strategy 1 intent, which applies to the fork as a request of
   * its own (design/context-management.md → Strategy 1). `/compact`, outside
   * a turn, sends none.
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
 * They also fire on size, since the server clears only after the bytes
 * arrive (design/context-management.md → Strategy 2 → Size trigger): a view
 * past 80% of `maxViewBytes` summarizes on any path without a count, since
 * counting it sends it, then takes the first of {@link truncations} within
 * 80%, else the first within the cap. A view goes as it is, counted, when
 * its smallest cut is past 80% and it fits the cap, since its bytes are in the
 * tail and cutting would only drop history it fits with; or when its smallest
 * cut is past the cap too, since no cut fits a 20 MB route and a 32 MB one
 * takes the view whole. A view past the cap logs a warning as it goes.
 */
export async function compactMessages(
  system: string,
  messages: ReadonlyArray<Message>,
  tools: ToolDefinition[] | undefined,
  deps: ContextManagerDeps,
  skipBudgetStrategies = false,
): Promise<CompactResult> {
  const { countTokens, budget, summarize, clearToolResults, maxViewBytes } = deps;
  const threshold = Math.floor(maxViewBytes * SUMMARIZE_THRESHOLD);
  const bytes = (msgs: ReadonlyArray<Message>): number => requestBytes(system, msgs, tools);
  // Whether the view's size needs compaction: past the threshold, with a cut
  // that fits the cap, unless the view fits it too and no cut gets it under
  // the threshold anyway.
  const oversized = (msgs: ReadonlyArray<Message>): boolean => {
    const size = bytes(msgs);
    if (size <= threshold) return false;
    const smallest = bytes(R.last(truncations(msgs)));
    return smallest <= maxViewBytes && (size > maxViewBytes || smallest <= threshold);
  };
  // A view past the cap here is one no cut fits.
  const sent = (compacted: CompactResult): CompactResult => {
    const size = bytes(compacted.messages);
    if (size > maxViewBytes) {
      logger.warn(
        { requestBytes: size, maxViewBytes },
        "sending a view past the request cap: no cut fits it",
      );
    }
    return compacted;
  };
  if (skipBudgetStrategies && !oversized(messages)) {
    return sent({ messages: [...messages], didCompact: false });
  }

  const strategies: CompactionEvent["strategies"] = [];
  let result = [...messages];
  let messagesSummarized = 0;
  const requestBytesBefore = bytes(result);

  const count = (msgs: Message[]): Promise<number | null> =>
    oversized(msgs)
      ? Promise.resolve(null)
      : countTokens({
          model: "",
          system,
          messages: msgs,
          clearToolResults,
          countUpTo: budget,
          ...(tools && { tools }),
        });

  let tokens = await count(result);
  const tokensBefore = tokens;

  // Strategy 2: Summarize conversation prefix at 80%, of the budget or the request cap
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

  // Strategy 3: on size, the first cut within the threshold, else the first
  // within the cap; on 95% of the budget, one cut
  const views = truncations(result);
  const cut = oversized(result)
    ? (views.find((view) => bytes(view) <= threshold) ??
      views.find((view) => bytes(view) <= maxViewBytes))
    : tokens !== null && tokens > budget * TRUNCATE_THRESHOLD
      ? views[1]
      : undefined;
  if (cut !== undefined && cut !== views[0]) {
    result = cut;
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
    return sent({ messages: result, didCompact: true, event });
  }
  return sent({ messages: result, didCompact: false });
}

/**
 * The request's raw size as the view holds it: every tool result and
 * attachment, before any clearing. The adapter's wire format differs by a few
 * key names, which the 20% margin under the cap absorbs. The UTF-8 bytes of
 * `JSON.stringify({ system, messages, tools })`, summed a message at a time,
 * so the views truncation weighs share each message's size.
 */
function requestBytes(
  system: string,
  messages: ReadonlyArray<Message>,
  tools: ToolDefinition[] | undefined,
): number {
  const frame = Buffer.byteLength(JSON.stringify({ system, messages: [], tools }));
  return frame + messagesBytes(messages);
}

/** The messages' part of {@link requestBytes}: each message, and the commas between them. */
function messagesBytes(messages: ReadonlyArray<Message>): number {
  return R.sumBy(messages, messageBytes) + Math.max(0, messages.length - 1);
}

const messageSizes = new WeakMap<Message, number>();

function messageBytes(message: Message): number {
  const known = messageSizes.get(message);
  if (known !== undefined) return known;
  const size = Buffer.byteLength(JSON.stringify(message));
  messageSizes.set(message, size);
  return size;
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

/**
 * The views truncation reaches from `messages`: `messages` itself, then each
 * cut with fewer bytes than every view before it, the one that only puts the
 * truncation marker in place of the first message included. Cuts run until
 * one changes nothing, past any the marker makes larger than the messages it
 * replaces. They end at the marker and the tail, three messages on plain
 * alternation and five after a tool call
 * (`[marker, tool_use, tool_result, reply, current]`), which is the last view
 * unless the marker outweighs what it replaced.
 */
export function truncations(messages: ReadonlyArray<Message>): [Message[], ...Message[][]] {
  let view = [...messages];
  const views: [Message[], ...Message[][]] = [view];
  for (;;) {
    const next = truncateOldest(view);
    // A cut is shorter, or as long and lighter: longer only by the marker,
    // which also makes it heavier. So the cuts end.
    if (next.length >= view.length && messagesBytes(next) >= messagesBytes(view)) return views;
    if (messagesBytes(next) < messagesBytes(R.last(views))) views.push(next);
    view = next;
  }
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
