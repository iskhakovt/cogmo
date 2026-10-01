import * as R from "remeda";
import type { Transaction, Transactor } from "../../db/index.js";
import type { Message } from "../../llm/types.js";
import { formatSummaryMessage } from "../context.js";
import type { TranscriptStore } from "../store/index.js";
import { type TurnContext, withTurnContext } from "../turn-context.js";

export interface LoadTurnHistoryDeps {
  runInTx: Transactor;
  agentStore: TranscriptStore;
}

export interface TurnHistory {
  messages: Message[];
  messageIds: (string | null)[];
  turnContexts: (TurnContext | null)[];
  turn: { id: string; createdAt: string } | null;
}

/** The turn's inbound cursor has no user row behind it: the turn can't be served. */
export class TurnRowMissingError extends Error {
  constructor(conversationId: string, inboundId: string) {
    super(`conversation ${conversationId} has no user row on inbound ${inboundId}`);
    this.name = "TurnRowMissingError";
  }
}

/**
 * Load a conversation's history as the turn should see it: the newest durable
 * summary standing in for everything up to its cutoff, followed by the
 * messages that arrived after, each turn-starting message led by the turn
 * context it was sent with.
 *
 * This is the compacted view, and it is deliberately not what `listMessages`
 * returns. The Observer and the web history read take the raw transcript, so
 * fact extraction still sees every turn; only the LLM-facing path collapses the
 * prefix and carries the turn contexts.
 *
 * `messageIds` and `turnContexts` are positionally aligned with `messages` —
 * `messageIds[i]` is the `messages` row backing `messages[i]`, or `null` for
 * the synthetic summary entry, and `turnContexts[i]` the structured inputs of
 * the block leading it, or `null` for a message without one. Callers that need
 * to map a compaction split point back to a durable cutoff (to persist a
 * summary of their own) walk `messageIds`; see `summarizedSpan`.
 *
 * `turn` is the row the running turn wrote, found in the same read by the
 * inbound cursor it was written with (`findUserMessageByInbound`): its id keys
 * the turn context and its `created_at`, as an ISO string since the result is
 * step state, is the time the context shows. `null` when the caller passes no
 * cursor, as `/compact` does; a cursor with no row behind it throws
 * `TurnRowMissingError`.
 */
export async function loadTurnHistory(
  deps: LoadTurnHistoryDeps,
  args: { conversationId: string; turnInboundId: string | null },
): Promise<TurnHistory> {
  return deps.runInTx(async (tx) => {
    const turn = await findTurn(tx, deps.agentStore, args.conversationId, args.turnInboundId);
    const summary = await deps.agentStore.getLatestSummary(tx, args.conversationId);
    const rows = summary
      ? await deps.agentStore.getHistoryAfter(tx, args.conversationId, summary.throughMessageId)
      : await deps.agentStore.listMessages(tx, args.conversationId);
    const stored = new Map(
      (
        await deps.agentStore.listTurnContexts(
          tx,
          args.conversationId,
          summary?.throughMessageId ?? null,
        )
      ).map((c) => [c.messageId, c] as const),
    );

    const messages = rows.map(({ id, role, content }): Message => {
      const context = stored.get(id);
      return context ? withTurnContext({ role, content }, context.rendered) : { role, content };
    });
    const messageIds = rows.map((row): string | null => row.id);
    const turnContexts = rows.map((row) => stored.get(row.id)?.context ?? null);

    if (!summary) return { messages, messageIds, turnContexts, turn };
    return {
      messages: [formatSummaryMessage(summary.summary), ...messages],
      messageIds: [null, ...messageIds],
      turnContexts: [null, ...turnContexts],
      turn,
    };
  });
}

async function findTurn(
  tx: Transaction,
  agentStore: TranscriptStore,
  conversationId: string,
  inboundId: string | null,
): Promise<TurnHistory["turn"]> {
  if (inboundId === null) return null;
  const row = await agentStore.findUserMessageByInbound(tx, conversationId, inboundId);
  if (row === undefined) throw new TurnRowMissingError(conversationId, inboundId);
  return { id: row.id, createdAt: row.createdAt.toISOString() };
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
