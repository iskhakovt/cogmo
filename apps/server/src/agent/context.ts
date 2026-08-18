/**
 * Context window management — ephemeral compaction pipeline.
 *
 * Four strategies applied gentlest-first:
 * 0. Same-tool supersession (count-based, unconditional check)
 * 1. Clear old tool results (60% of budget)
 * 2. Summarize conversation prefix (80% of budget)
 * 3. Truncate oldest messages (95% of budget)
 *
 * See design/context-management.md for full design.
 */

import * as R from "remeda";
import type { ContentBlock, CountTokensParams, Message, ToolDefinition } from "../llm/types.js";
import { logger } from "../logger.js";

// --- Public interface ---

export interface ContextManagerDeps {
  /** Count tokens for the given request parameters. */
  countTokens: (params: CountTokensParams) => Promise<number>;
  /** Maximum input tokens before rejection (contextWindow - maxOutputTokens - safetyBuffer). */
  budget: number;
  /**
   * Make a summarization LLM call. Receives system prompt + messages to summarize.
   *
   * Contract: called **at most once** per `compactMessages` invocation. Callers
   * (notably `handle-message`) rely on this to wrap the call in a single Inngest
   * step with a fixed step ID (`summarize-prefix`). If a future strategy ever
   * needs segmented summarization, this contract — and the hardcoded step ID at
   * the call site — must change in lockstep.
   */
  summarize?: (system: string, messages: Message[]) => Promise<string>;
  /** Called when summarization starts (for user feedback via stream events). */
  onStatus?: (message: string) => void;
}

export interface CompactionEvent {
  strategies: ("compact_same_tool_clusters" | "clear_tool_results" | "summarize" | "truncate")[];
  tokensBefore: number;
  tokensAfter: number;
  toolResultsCleared: number;
  messagesSummarized: number;
  sameToolClustersCompacted: number;
  sameToolResultsSuperseded: number;
}

export interface CompactResult {
  messages: Message[];
  didCompact: boolean;
  event?: CompactionEvent;
}

const CLEAR_THRESHOLD = 0.6;
const SUMMARIZE_THRESHOLD = 0.8;
const TRUNCATE_THRESHOLD = 0.95;

const DEFAULT_KEEP_TOOL_RESULTS = 5;
const DEFAULT_KEEP_TURNS = 6;

// Strategy 0 defaults — see design/context-management.md → Strategy 0.
// triggerCount = retainRecent + retainFirst + 2 → first fire compacts
// 2 results, making the cache-invalidation cost worthwhile.
const DEFAULT_RETAIN_RECENT = 2;
const DEFAULT_RETAIN_FIRST = 1;
const DEFAULT_TRIGGER_COUNT = 5;

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
 * Run the compaction pipeline on conversation messages. Returns the
 * (possibly compacted) messages and metadata about what was applied.
 *
 * Strategy 0 (same-tool supersession) runs **always** because it's
 * count-based and structural — it doesn't depend on the token budget,
 * and skipping it on a low-budget turn would defeat the whole point
 * (volume-driven attention dilution happens regardless of budget
 * headroom). Strategies 1–3 are budget-pressure-triggered and gated
 * by `skipBudgetStrategies`: callers that know the turn is comfortably
 * under budget (via `shouldSkipCounting`) can avoid the expensive
 * `countTokens` round-trip by passing `true`.
 */
export async function compactMessages(
  system: string,
  messages: ReadonlyArray<Message>,
  tools: ToolDefinition[] | undefined,
  deps: ContextManagerDeps,
  skipBudgetStrategies = false,
): Promise<CompactResult> {
  const { countTokens, budget, summarize, onStatus } = deps;
  const strategies: CompactionEvent["strategies"] = [];
  let result = [...messages];
  let toolResultsCleared = 0;
  let messagesSummarized = 0;
  let sameToolClustersCompacted = 0;
  let sameToolResultsSuperseded = 0;

  const count = (msgs: Message[]) =>
    countTokens({ model: "", system, messages: msgs, ...(tools && { tools }) });

  // Strategy 0 — always. Cheap O(N) scan; per-block no-op skip means
  // idempotent re-application doesn't inflate telemetry.
  const supersession = compactSameToolClusters(result, {
    retainRecent: DEFAULT_RETAIN_RECENT,
    retainFirst: DEFAULT_RETAIN_FIRST,
    triggerCount: DEFAULT_TRIGGER_COUNT,
  });
  if (supersession.resultsCompacted > 0) {
    result = supersession.messages;
    sameToolClustersCompacted = supersession.clusters;
    sameToolResultsSuperseded = supersession.resultsCompacted;
    strategies.push("compact_same_tool_clusters");
  }

  if (skipBudgetStrategies) {
    if (strategies.length > 0) {
      const event: CompactionEvent = {
        strategies,
        // tokensBefore/tokensAfter are absent on the skip-counting path —
        // the caller's fast-path heuristic already decided the budget
        // strategies aren't worth a real countTokens call. Use 0 as a
        // sentinel; downstream telemetry consumers should rely on the
        // strategies array, not absolute counts, when this flag was set.
        tokensBefore: 0,
        tokensAfter: 0,
        toolResultsCleared,
        messagesSummarized,
        sameToolClustersCompacted,
        sameToolResultsSuperseded,
      };
      logger.info(
        event,
        "context compaction applied (Strategy 0 only — budget strategies skipped)",
      );
      return { messages: result, didCompact: true, event };
    }
    return { messages: result, didCompact: false };
  }

  let tokens = await count(result);
  const tokensBefore = tokens;

  // Strategy 1: Clear old tool results at 60%
  if (tokens > budget * CLEAR_THRESHOLD) {
    const cleared = clearToolResults(result, DEFAULT_KEEP_TOOL_RESULTS);
    result = cleared.messages;
    toolResultsCleared = cleared.clearedCount;
    if (toolResultsCleared > 0) {
      strategies.push("clear_tool_results");
      tokens = await count(result);
    }
  }

  // Strategy 2: Summarize conversation prefix at 80%
  if (tokens > budget * SUMMARIZE_THRESHOLD && summarize) {
    onStatus?.("Summarizing conversation...");
    try {
      const summarized = await summarizePrefix(result, system, summarize, DEFAULT_KEEP_TURNS);
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

  // Strategy 3: Emergency truncation at 95%
  if (tokens > budget * TRUNCATE_THRESHOLD) {
    result = truncateOldest(result);
    strategies.push("truncate");
    tokens = await count(result);
  }

  if (strategies.length > 0) {
    const event: CompactionEvent = {
      strategies,
      tokensBefore,
      tokensAfter: tokens,
      toolResultsCleared,
      messagesSummarized,
      sameToolClustersCompacted,
      sameToolResultsSuperseded,
    };
    logger.info(event, "context compaction applied");
    return { messages: result, didCompact: true, event };
  }
  return { messages: result, didCompact: false };
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

const CLEARED_PLACEHOLDER = "[Cleared — call tool again if needed]";

export interface SupersessionOpts {
  retainRecent: number;
  retainFirst: number;
  triggerCount: number;
}

export interface SupersessionResult {
  messages: Message[];
  clusters: number;
  resultsCompacted: number;
}

interface ToolResultPos {
  msgIdx: number;
  blockIdx: number;
  toolUseId: string;
  /** Current `tool_result.content` byte length — for the no-op + size-gate checks. */
  currentLen: number;
}

/**
 * Strategy 0 — same-tool supersession. For each tool whose `tool_result`
 * blocks in `messages` total at least `triggerCount`, replace the
 * middle results (between `retainFirst` at the front and `retainRecent`
 * at the back) with a single aggregate-summary string. Arg shapes are
 * read from the paired `tool_use.input` via an id-to-name index so
 * previously-compacted blocks still contribute the original call's
 * context to the new summary.
 *
 * Cardinal rule: only `tool_result.content` is mutated; `tool_use`
 * blocks are left intact. Anthropic's tool_use ↔ tool_result pairing
 * invariant holds by construction. The earliest-positioned tool_result
 * for each tool is preserved verbatim across all subsequent passes
 * ("sticky first") — every pass identifies it by position in the
 * message array, never by content.
 *
 * Two guards keep the transform honest:
 *
 *  - **Size gate**: if the aggregate byte size of the middle results
 *    would not shrink (or shrinks negligibly) under compaction, skip
 *    the cluster. Strategy 0's claim of "never increases token count"
 *    holds only when the replacement summary is smaller per block on
 *    average than what it replaces — for tools that return very small
 *    payloads (`"ok"` from a write-style tool) the summary would grow
 *    the array. Skipping in that case preserves the invariant.
 *  - **No-op skip**: idempotent re-application (the steady state after
 *    the first fire) finds the same `summary` text already present on
 *    every middle block. The per-block apply loop compares old vs.
 *    new content and only counts blocks that actually changed, so
 *    `resultsCompacted` reflects real work and downstream telemetry
 *    doesn't flip `didCompact: true` every turn.
 *
 * See `design/context-management.md` → Strategy 0: Same-Tool
 * Supersession.
 */
export function compactSameToolClusters(
  messages: ReadonlyArray<Message>,
  opts: SupersessionOpts,
): SupersessionResult {
  const { retainRecent, retainFirst, triggerCount } = opts;

  // Index every tool_use block by id → { name, input }.
  const toolUseById = new Map<string, { name: string; input: unknown }>(
    R.pipe(
      messages,
      R.flatMap((msg) =>
        msg.role === "assistant" && Array.isArray(msg.content) ? msg.content : [],
      ),
      R.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"),
      R.map((b) => [b.id, { name: b.name, input: b.input }] as const),
    ),
  );

  // Walk every tool_result block, resolve its tool name via the paired
  // tool_use, bucket by tool name. Preserves the order they appear in
  // the message array (oldest → newest), which is the order
  // `retainFirst` / `retainRecent` slice against.
  const positionsByTool = new Map<string, ToolResultPos[]>();
  for (const [msgIdx, msg] of messages.entries()) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    for (const [blockIdx, block] of msg.content.entries()) {
      if (block.type !== "tool_result") continue;
      const toolUse = toolUseById.get(block.toolUseId);
      if (!toolUse) continue;
      const list = positionsByTool.get(toolUse.name) ?? [];
      list.push({
        msgIdx,
        blockIdx,
        toolUseId: block.toolUseId,
        currentLen: block.content.length,
      });
      positionsByTool.set(toolUse.name, list);
    }
  }

  // For each cluster over threshold, run the size gate and record
  // per-position replacements. No-op detection happens in the apply
  // pass below — idempotent re-application produces the same summary
  // string on every middle block, and the byte comparison there skips
  // rewrites that wouldn't change content.
  const replacements = new Map<string, string>();

  for (const [toolName, positions] of positionsByTool) {
    if (positions.length < triggerCount) continue;
    const middleStart = retainFirst;
    const middleEnd = positions.length - retainRecent;
    if (middleEnd <= middleStart) continue;

    const middle = positions.slice(middleStart, middleEnd);
    const argShapes = middle.map((p) => formatToolUseArgs(toolUseById.get(p.toolUseId)?.input));
    const summary =
      `[Same-tool cluster: ${middle.length} prior \`${toolName}\` results compacted — calls: ` +
      `${argShapes.join("; ")}. Latest ${retainRecent} verbatim below.]`;

    // Size gate. Use byte length as a tokenization proxy: only compact
    // if the summary would shrink the aggregate. For tools returning
    // tiny payloads (`"ok"` from a write-style tool) the summary can
    // be longer per block than the original content; compacting would
    // grow the array and contradict the design's "doesn't increase
    // token count" claim.
    const aggregateMiddleLen = middle.reduce((sum, pos) => sum + pos.currentLen, 0);
    const aggregateSummaryLen = middle.length * summary.length;
    if (aggregateSummaryLen >= aggregateMiddleLen) continue;

    for (const pos of middle) {
      replacements.set(`${pos.msgIdx}:${pos.blockIdx}`, summary);
    }
  }

  if (replacements.size === 0) {
    return { messages: [...messages], clusters: 0, resultsCompacted: 0 };
  }

  // Apply pass: rewrite tool_result content where the planned summary
  // differs from the current bytes (no-op skip), count actual changes
  // by tool, and only allocate new message/content arrays for messages
  // that had at least one block change.
  const clusterTouched = new Set<string>();
  let resultsCompacted = 0;
  const result = messages.map((msg, msgIdx) => {
    if (typeof msg.content === "string") return msg;
    let modified = false;
    const newContent = msg.content.map((block, blockIdx) => {
      const replacement = replacements.get(`${msgIdx}:${blockIdx}`);
      if (replacement === undefined) return block;
      if (block.type !== "tool_result") return block;
      if (block.content === replacement) return block; // Idempotent — already compacted.
      modified = true;
      resultsCompacted++;
      const toolUse = toolUseById.get(block.toolUseId);
      if (toolUse) clusterTouched.add(toolUse.name);
      return { ...block, content: replacement };
    });
    return modified ? { ...msg, content: newContent } : msg;
  });

  return { messages: result, clusters: clusterTouched.size, resultsCompacted };
}

/**
 * Compact one-line representation of a `tool_use.input` for the
 * supersession summary text. Falls back to a JSON-ish render for shapes
 * that don't look like a simple-string-keyed bag.
 */
function formatToolUseArgs(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  // Pick the first string-valued entry as the most descriptive
  // (query, prompt, path, etc.); fall back to JSON for the rest.
  const stringEntry = entries.find(([, v]) => typeof v === "string" && v.length > 0);
  if (stringEntry) {
    const [k, v] = stringEntry as [string, string];
    const trimmed = v.length > 80 ? `${v.slice(0, 77)}...` : v;
    return `${k}: ${JSON.stringify(trimmed)}`;
  }
  const json = JSON.stringify(input);
  return json.length > 100 ? `${json.slice(0, 97)}...` : json;
}

function clearToolResults(
  messages: Message[],
  keep: number,
): { messages: Message[]; clearedCount: number } {
  // Collect all tool_result positions across all messages
  const toolResultPositions = R.pipe(
    messages,
    R.flatMap((msg, msgIdx) => {
      if (typeof msg.content === "string") return [];
      return R.pipe(
        msg.content,
        R.map((block, blockIdx) => ({ block, msgIdx, blockIdx })),
        R.filter(
          ({ block }) => block.type === "tool_result" && block.content !== CLEARED_PLACEHOLDER,
        ),
        R.map(({ msgIdx, blockIdx }) => ({ msgIdx, blockIdx })),
      );
    }),
  );

  // Keep the last `keep` tool results intact
  const clearCount = Math.max(0, toolResultPositions.length - keep);
  if (clearCount === 0) return { messages, clearedCount: 0 };

  const toClear = new Set(
    R.pipe(
      toolResultPositions,
      R.take(clearCount),
      R.map((p) => `${p.msgIdx}:${p.blockIdx}`),
    ),
  );

  const result = R.map(messages, (msg, msgIdx) => {
    if (typeof msg.content === "string") return msg;

    const newContent = R.map(msg.content, (block, blockIdx) =>
      block.type === "tool_result" && toClear.has(`${msgIdx}:${blockIdx}`)
        ? { ...block, content: CLEARED_PLACEHOLDER }
        : block,
    );
    const modified = newContent.some((b, i) => b !== (msg.content as ContentBlock[])[i]);
    return modified ? { ...msg, content: newContent } : msg;
  });

  return { messages: result, clearedCount: clearCount };
}

async function summarizePrefix(
  messages: Message[],
  system: string,
  summarize: (system: string, messages: Message[]) => Promise<string>,
  keepTurns: number,
): Promise<{ messages: Message[]; summarizedCount: number }> {
  // Keep the last keepTurns messages (user/assistant pairs)
  const rawSplit = Math.max(0, messages.length - keepTurns);
  if (rawSplit <= 0) return { messages, summarizedCount: 0 };

  const splitIdx = snapToPairBoundary(messages, rawSplit);
  if (splitIdx <= 0) return { messages, summarizedCount: 0 };

  const prefix = messages.slice(0, splitIdx);
  const suffix = messages.slice(splitIdx);

  const summary = await summarize(system, prefix);

  // An empty summary would otherwise be wrapped in the header below and
  // returned in place of `prefix`, discarding that whole span of the
  // conversation and leaving the header as the only trace. Report it as
  // "summarized nothing" instead, which the caller already treats as
  // leaving the messages alone, so emergency truncation still gets its
  // turn. Reachable whenever the summarization model spends its output
  // budget on reasoning and returns no text.
  if (summary.trim().length === 0) {
    logger.warn(
      { prefixLength: prefix.length },
      "summarization returned no text — keeping the prefix and falling through to truncation",
    );
    return { messages, summarizedCount: 0 };
  }

  const summaryMessage: Message = {
    role: "user",
    content: `[Previous conversation summary]\n\n${summary}`,
  };

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
