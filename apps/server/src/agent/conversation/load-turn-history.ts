import * as R from "remeda";
import type { Transactor } from "../../db/index.js";
import type { Message } from "../../llm/types.js";
import { formatSummaryMessage } from "../context.js";
import type { AgentStore } from "../store/index.js";

/**
 * Load a conversation's history as the turn should see it: the newest durable
 * summary standing in for everything up to its cutoff, followed by the
 * messages that arrived after.
 *
 * This is the compacted view, and it is deliberately not what `getHistory`
 * returns. The Observer reads the raw transcript so fact extraction still sees
 * every turn; only the LLM-facing path collapses the prefix.
 *
 * `messageIds` is positionally aligned with `messages` — `messageIds[i]` is the
 * `messages` row backing `messages[i]`, or `null` for the synthetic summary
 * entry. Callers that need to map a compaction split point back to a durable
 * cutoff (to persist a summary of their own) walk this array; see
 * `summaryCutoffFor`.
 */
export interface LoadTurnHistoryDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

export interface TurnHistory {
  messages: Message[];
  messageIds: (string | null)[];
}

export async function loadTurnHistory(
  deps: LoadTurnHistoryDeps,
  args: { conversationId: string },
): Promise<TurnHistory> {
  return deps.runInTx(async (tx) => {
    const summary = await deps.agentStore.getLatestSummary(tx, args.conversationId);
    const rows = summary
      ? await deps.agentStore.getHistoryAfter(tx, args.conversationId, summary.throughMessageId)
      : await deps.agentStore.listMessages(tx, args.conversationId);

    const messages = rows.map(({ role, content }): Message => ({ role, content }));
    const messageIds = rows.map((row): string | null => row.id);

    if (!summary) return { messages, messageIds };
    return {
      messages: [formatSummaryMessage(summary.summary), ...messages],
      messageIds: [null, ...messageIds],
    };
  });
}

/**
 * The durable cutoff a summary covering `messages[0 … splitIdx)` should record.
 *
 * Returns the last real message id inside the summarized span, or `null` when
 * the span holds no persisted messages at all — which happens only when the
 * span is the previously-stored summary and nothing else. Persisting that
 * would re-summarize a summary while advancing nothing, so callers treat
 * `null` as "there is nothing new to compact".
 */
export function summaryCutoffFor(
  messageIds: ReadonlyArray<string | null>,
  splitIdx: number,
): string | null {
  return (
    R.pipe(messageIds.slice(0, Math.max(0, splitIdx)), R.filter(R.isNonNullish), R.last()) ?? null
  );
}
