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
 * This is the compacted view, and it is deliberately not what `listMessages`
 * returns. The Observer and the web history read take the raw transcript, so
 * fact extraction still sees every turn; only the LLM-facing path collapses the
 * prefix.
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
 * What a summary covering `messages[0 … splitIdx)` actually replaces.
 *
 * `cutoff` is the last persisted message id inside the span — the durable
 * position the summary advances to. `messageCount` counts only real messages,
 * excluding the synthetic entry a previous summary occupies: a span of
 * `[storedSummary, m1, m2]` replaces two messages, not three, and any floor
 * expressed in messages has to say so.
 *
 * `null` when the span holds no persisted messages at all, which happens only
 * when it is the previously-stored summary and nothing else — summarizing that
 * re-summarizes a summary while advancing nothing.
 */
export function summarizedSpan(
  messageIds: ReadonlyArray<string | null>,
  splitIdx: number,
): { cutoff: string; messageCount: number } | null {
  const real = R.pipe(messageIds.slice(0, Math.max(0, splitIdx)), R.filter(R.isNonNullish));
  const cutoff = R.last(real);
  return cutoff === undefined ? null : { cutoff, messageCount: real.length };
}
