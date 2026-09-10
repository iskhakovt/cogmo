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
export const MIN_MESSAGES_TO_COMPACT = 4;

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
       * `too_short` — too little outside the retain window to be worth a
       * call. `nothing_new` — everything outside it is already covered, or a
       * concurrent turn stored the same span first. `empty_summary` — the model
       * spent its budget reasoning and returned no text.
       */
      reason: "too_short" | "nothing_new" | "empty_summary";
    }
  /**
   * `conversation` — the row vanished between the caller resolving it and this
   * load. `profile` — the conversation is there but its profile is gone, which
   * is a broken conversation rather than an absent one and needs saying so.
   */
  | { status: "not_found"; missing: "conversation" | "profile" };

export async function compactConversation(
  conversationId: string,
  deps: CompactConversationDeps,
): Promise<CompactConversationResult> {
  // Conversation and profile share a tx: a `/profile switch` landing between
  // the two reads would otherwise pair a conversation with a profile that is no
  // longer its own, and the profile supplies both the summarization model and
  // the base prompt. The history read below deliberately takes its own
  // snapshot — it wants the newest transcript, and a turn committing in between
  // only appends, so the summary describes a prefix either way.
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

  // Write and re-read in one tx. A turn that compacted while the summarization
  // was in flight supersedes this row two ways: it can take the same cutoff, in
  // which case the conflict arm keeps its text and `kind` is `recovered`; or it
  // can take a wider one, in which case this insert succeeds but
  // `getLatestSummary` — which orders by coverage — will never return it.
  // Either way the summary the user paid for is not the one that will be used,
  // and reporting success would promise an effect that never happens.
  const superseded = await deps.runInTx(async (tx) => {
    const { kind } = await deps.agentStore.insertOrRecoverSummary(tx, {
      conversationId,
      summary,
      throughMessageId: span.cutoff,
      messagesSummarized: splitIdx,
      model,
      source: "manual",
    });
    if (kind === "recovered") return true;
    const latest = await deps.agentStore.getLatestSummary(tx, conversationId);
    return latest?.throughMessageId !== span.cutoff;
  });
  if (superseded) return { status: "skipped", reason: "nothing_new" };

  return {
    status: "compacted",
    messagesSummarized: span.messageCount,
    messagesKept: messages.length - splitIdx,
    model,
  };
}
