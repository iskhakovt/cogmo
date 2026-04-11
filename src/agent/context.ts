/**
 * Context window management — ephemeral compaction pipeline.
 *
 * Three strategies applied gentlest-first:
 * 1. Clear old tool results (60% of budget)
 * 2. Summarize conversation prefix (80% of budget)
 * 3. Truncate oldest messages (95% of budget)
 *
 * See design/context-management.md for full design.
 */

import type { CountTokensParams, Message, ToolDefinition } from "../llm/types.js";
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
  strategies: ("clear_tool_results" | "summarize" | "truncate")[];
  tokensBefore: number;
  tokensAfter: number;
  toolResultsCleared: number;
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

const DEFAULT_KEEP_TOOL_RESULTS = 5;
const DEFAULT_KEEP_TURNS = 6;

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
 * Run the compaction pipeline on conversation messages.
 * Returns the (possibly compacted) messages and metadata about what was applied.
 */
export async function compactMessages(
  system: string,
  messages: ReadonlyArray<Message>,
  tools: ToolDefinition[] | undefined,
  deps: ContextManagerDeps,
): Promise<CompactResult> {
  const { countTokens, budget, summarize, onStatus } = deps;
  const strategies: CompactionEvent["strategies"] = [];
  let result = [...messages];
  let toolResultsCleared = 0;
  let messagesSummarized = 0;

  const count = (msgs: Message[]) =>
    countTokens({ model: "", system, messages: msgs, ...(tools && { tools }) });

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
    };
    logger.info(event, "context compaction applied");
    return { messages: result, didCompact: true, event };
  }
  return { messages: result, didCompact: false };
}

/**
 * Fast-path check: should we skip the expensive countTokens call?
 * Returns true if the conversation is clearly under budget.
 */
export function shouldSkipCounting(
  lastInputTokens: number | null,
  newContentChars: number,
  budget: number,
): boolean {
  if (lastInputTokens === null) return false;
  const estimate = lastInputTokens + Math.ceil(newContentChars / 4);
  return estimate < budget * 0.5;
}

// --- Internal strategies ---

const CLEARED_PLACEHOLDER = "[Cleared — call tool again if needed]";

function clearToolResults(
  messages: Message[],
  keep: number,
): { messages: Message[]; clearedCount: number } {
  // Count total tool_result blocks to know which ones to keep
  const toolResultPositions: Array<{ msgIdx: number; blockIdx: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const content = messages[i]?.content;
    if (typeof content === "string" || !content || !Array.isArray(content)) continue;
    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      if (block?.type === "tool_result" && block.content !== CLEARED_PLACEHOLDER) {
        toolResultPositions.push({ msgIdx: i, blockIdx: j });
      }
    }
  }

  // Keep the last `keep` tool results intact
  const clearCount = Math.max(0, toolResultPositions.length - keep);
  if (clearCount === 0) return { messages, clearedCount: 0 };

  const toClear = new Set(
    toolResultPositions.slice(0, clearCount).map((p) => `${p.msgIdx}:${p.blockIdx}`),
  );

  const result = messages.map((msg, msgIdx) => {
    if (typeof msg.content === "string" || !msg.content) return msg;

    let modified = false;
    const newContent = msg.content.map((block, blockIdx) => {
      if (block.type === "tool_result" && toClear.has(`${msgIdx}:${blockIdx}`)) {
        modified = true;
        return { ...block, content: CLEARED_PLACEHOLDER };
      }
      return block;
    });

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
  const splitIdx = Math.max(0, messages.length - keepTurns);
  if (splitIdx <= 0) return { messages, summarizedCount: 0 };

  const prefix = messages.slice(0, splitIdx);
  const suffix = messages.slice(splitIdx);

  const summary = await summarize(system, prefix);

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
  const dropCount = Math.min(Math.max(Math.ceil(messages.length * 0.3), 2), messages.length - 2);
  const result = messages.slice(dropCount);

  // Ensure alternation — first message must be user role
  if (result.length > 0 && result[0]?.role !== "user") {
    result.unshift({
      role: "user",
      content: "[Earlier conversation history was truncated]",
    });
  }

  return result;
}
