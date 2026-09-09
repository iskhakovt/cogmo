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
import { loadTurnHistory, summaryCutoffFor } from "./load-turn-history.js";

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
 * construction — the turn froze its history inside `load-history`, and this
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
      /** Entries of the turn view the summary replaced. */
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
  | { status: "not_found" };

export async function compactConversation(
  conversationId: string,
  deps: CompactConversationDeps,
): Promise<CompactConversationResult> {
  // Conversation and profile in one tx: a `/profile switch` landing between
  // two reads would otherwise pair a conversation with a profile that is no
  // longer its own, and the profile is what supplies both the summarization
  // model and the base prompt.
  const loaded = await deps.runInTx(async (tx) => {
    const conversation = await deps.agentStore.getConversation(tx, conversationId);
    if (!conversation) return null;
    const profile = await deps.agentStore.getProfile(tx, conversation.profileId);
    return profile ? { profile } : null;
  });
  if (!loaded) return { status: "not_found" };
  const { profile } = loaded;

  const { messages, messageIds } = await loadTurnHistory(
    { runInTx: deps.runInTx, agentStore: deps.agentStore },
    { conversationId },
  );

  // Same split the budget-triggered strategy would pick, so a manual
  // compaction and an automatic one cover comparable spans.
  const splitIdx = snapToPairBoundary(messages, Math.max(0, messages.length - DEFAULT_KEEP_TURNS));
  if (splitIdx < MIN_MESSAGES_TO_COMPACT) return { status: "skipped", reason: "too_short" };

  const throughMessageId = summaryCutoffFor(messageIds, splitIdx);
  if (throughMessageId === null) return { status: "skipped", reason: "nothing_new" };

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

  const { kind } = await deps.runInTx((tx) =>
    deps.agentStore.insertOrRecoverSummary(tx, {
      conversationId,
      summary,
      throughMessageId,
      messagesSummarized: splitIdx,
      model,
      source: "manual",
    }),
  );
  // `recovered` means a concurrent turn stored this same span while the
  // summarization was in flight, and the conflict arm kept its text. Reporting
  // success would describe a summary that was thrown away.
  if (kind === "recovered") return { status: "skipped", reason: "nothing_new" };

  return {
    status: "compacted",
    messagesSummarized: splitIdx,
    messagesKept: messages.length - splitIdx,
    model,
  };
}
