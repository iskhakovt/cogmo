import type { Transactor } from "../../db/index.js";
import { resolveLimits } from "../../llm/models.js";
import type { LlmProviderResolver } from "../../llm/resolver.js";
import type { TransportStore } from "../../transport/store/index.js";
import {
  compactSameToolClusters,
  DEFAULT_KEEP_TURNS,
  extractSummaryText,
  snapToPairBoundary,
  summarizationRequest,
} from "../context.js";
import type { PromptSource } from "../prompt.js";
import type { AgentStore } from "../store/index.js";
import { loadConversationContext } from "./load-conversation-context.js";
import { loadTurnHistory, summarizedSpan } from "./load-turn-history.js";

/** Stores and services `compactConversation` needs; see that function's doc. */
export interface CompactConversationDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: TransportStore;
  resolveProvider: LlmProviderResolver;
  promptSource: PromptSource;
}

/**
 * Messages a manual compaction must be able to collapse before it is worth an
 * LLM call. Below this the summary would stand in for a turn or two, saving no
 * tokens while paraphrasing away detail the raw messages still carry — the
 * budget-triggered path has no such floor because reaching 80% of the window on
 * that few messages means they are individually enormous.
 */
const MIN_MESSAGES_TO_COMPACT = 4;

export type CompactConversationResult =
  | {
      status: "compacted";
      /** Real messages the summary replaced — excludes a previous summary folded in. */
      messagesSummarized: number;
      /** Messages left verbatim after the summary. */
      messagesKept: number;
      model: string;
    }
  | {
      status: "skipped";
      /**
       * `too_short` — fewer than `MIN_MESSAGES_TO_COMPACT` real messages sit
       * outside the retain window, which also covers a span holding nothing but
       * the previously-stored summary. `nothing_new` — a concurrent turn won
       * the race, either by taking this same cutoff (the conflict arm kept its
       * text) or a wider one (this row was written but coverage-ordered reads
       * will never return it). `empty_summary` — the model spent its budget
       * reasoning and returned no text. `truncated` — it hit its output cap, so
       * the text is cut mid-sentence and must not become the permanent stand-in
       * for a span nothing re-derives.
       */
      reason: "too_short" | "nothing_new" | "empty_summary" | "truncated";
    }
  /**
   * `conversation` — the row vanished between the caller resolving it and this
   * load. `profile` — the conversation is there but its profile is gone, which
   * is a broken conversation rather than an absent one and needs saying so.
   */
  | { status: "not_found"; missing: "conversation" | "profile" };

/**
 * Synchronous driver for the `/compact` manual trigger.
 *
 * The turn-time path only summarizes under budget pressure (Strategy 2 at 80%)
 * and pays the latency at the front of the user's next turn. This forces the
 * same split immediately, on demand, and stores the result — so the next turn
 * starts from a summary it did not have to wait for.
 *
 * Sidesteps Inngest for the same reasons `triggerReflection` does: the user is
 * waiting on the reply, single-user scale means there is no concurrent fire to
 * race, and an LLM or DB error surfaces to the caller rather than disappearing
 * into a retry log. A `/compact` racing an in-flight turn is safe by
 * construction — the turn froze its history inside `load-turn-history`, and this
 * only ever covers a prefix of what that turn already read.
 */
export async function compactConversation(
  conversationId: string,
  deps: CompactConversationDeps,
): Promise<CompactConversationResult> {
  // Conversation and profile share a tx: a `/profile switch` landing between
  // the two reads would otherwise pair a conversation with a profile that is no
  // longer its own, and the profile supplies both the summarization model and
  // the base prompt.
  //
  // The reads that follow each take their own snapshot, deliberately. The
  // history read wants the newest transcript, and a turn committing in between
  // only appends, so the summary describes a prefix either way. The steering
  // rules could in principle resolve under a snapshot a `/profile switch` has
  // moved past — that flavours the summarization prompt with the outgoing
  // profile's rules, a cosmetic loss set against reshaping a shared use case
  // to take a `tx`.
  const loaded = await deps.runInTx(async (tx) => {
    const conversation = await deps.agentStore.getConversation(tx, conversationId);
    if (!conversation) return { missing: "conversation" as const };
    const profile = await deps.agentStore.getProfile(tx, conversation.profileId);
    return profile ? { profile } : { missing: "profile" as const };
  });
  if (!("profile" in loaded)) return { status: "not_found", missing: loaded.missing };
  const { profile } = loaded;

  const { messages, messageIds } = await loadTurnHistory(
    { runInTx: deps.runInTx, agentStore: deps.agentStore },
    { conversationId },
  );

  // Same split the budget-triggered strategy would pick, so a manual
  // compaction and an automatic one cover comparable spans.
  const splitIdx = snapToPairBoundary(messages, Math.max(0, messages.length - DEFAULT_KEEP_TURNS));
  // The floor counts real messages, so a span that is mostly the previously
  // stored summary doesn't clear it on the strength of an entry that is already
  // a summary. A span with no real messages at all fails the same check.
  const span = summarizedSpan(messageIds, splitIdx);
  if (span === null || span.messageCount < MIN_MESSAGES_TO_COMPACT) {
    return { status: "skipped", reason: "too_short" };
  }

  // Strategy 0 before summarizing, matching the turn-time ladder's first rung:
  // repeated same-tool results in the prefix collapse to one aggregate line, so
  // the summarizer reads a cleaner transcript and a tool-heavy prefix shrinks
  // before it reaches the model. Structural and count-based — no token count
  // needed, which is what lets the manual path run it unconditionally.
  const prefix = compactSameToolClusters(messages.slice(0, splitIdx), {
    retainRecent: 2,
    retainFirst: 1,
    triggerCount: 5,
  }).messages;

  // Tool definitions are omitted: resolving the per-turn catalog means
  // composing MCP and skill tools, and the summarizer uses the system prompt
  // only to recognise what is already stated elsewhere. A missing `# Tools`
  // section can make it preserve a little more, never less.
  const context = await loadConversationContext(
    {
      runInTx: deps.runInTx,
      agentStore: deps.agentStore,
      transportStore: deps.transportStore,
    },
    { conversationId, profile },
  );
  const system = await deps.promptSource.assemble({ profile, rules: context.rules });

  const model = profile.summarizationModel ?? profile.model;
  const { provider, limits: rowLimits } = await deps.resolveProvider(model);
  const limits = resolveLimits(model, rowLimits);

  const response = await provider.chat(
    summarizationRequest({
      model,
      system,
      messages: prefix,
      maxOutputTokens: limits.maxOutputTokens,
    }),
  );
  const summary = extractSummaryText(response.content);
  if (summary.trim().length === 0) return { status: "skipped", reason: "empty_summary" };
  // Storing a summary cut off at its output cap would freeze a half-written
  // stand-in for a span later turns stop loading. The empty case is guarded
  // just above; this is the same budget running out one step later.
  if (response.stopReason === "max_tokens") return { status: "skipped", reason: "truncated" };

  // A turn that compacted while the summarization was in flight supersedes this
  // row two ways: it can take the same cutoff, where the conflict arm keeps its
  // text and `kind` is `recovered`; or a wider one, where this insert succeeds
  // but `getLatestSummary` — which orders by coverage — will never return it.
  // Either way the summary the user paid for is not the one that gets used, and
  // reporting success would promise an effect that never happens.
  const { kind } = await deps.runInTx((tx) =>
    deps.agentStore.insertOrRecoverSummary(tx, {
      conversationId,
      summary,
      throughMessageId: span.cutoff,
      messagesSummarized: span.messageCount,
      model,
      source: "manual",
    }),
  );
  // The wider-cutoff check reads in its own transaction, deliberately. Under
  // the project's REPEATABLE READ default a snapshot is taken at a
  // transaction's first statement, so a read sharing the insert's transaction
  // would be blind to anything committed after it — including, in the gap
  // between the two statements, the very row it is looking for.
  const superseded =
    kind === "recovered" ||
    (await deps.runInTx(async (tx) => {
      const latest = await deps.agentStore.getLatestSummary(tx, conversationId);
      return latest?.throughMessageId !== span.cutoff;
    }));
  if (superseded) return { status: "skipped", reason: "nothing_new" };

  return {
    status: "compacted",
    messagesSummarized: span.messageCount,
    messagesKept: messages.length - splitIdx,
    model,
  };
}
