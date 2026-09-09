import type { Transactor } from "../../db/index.js";
import { resolveLimits } from "../../llm/models.js";
import type { LlmProviderResolver } from "../../llm/resolver.js";
import type { TransportStore } from "../../transport/store/index.js";
import { DEFAULT_KEEP_TURNS, SUMMARIZATION_PROMPT, snapToPairBoundary } from "../context.js";
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
 * race, and an LLM or DB error surfaces to the caller as a thrown Error rather
 * than disappearing into a retry log. A `/compact` racing an in-flight turn is
 * safe by construction — the turn froze its history inside `load-history`, and
 * this only ever covers a prefix of what that turn already read.
 */
export interface CompactConversationDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: TransportStore;
  resolveProvider: LlmProviderResolver;
  promptSource: PromptSource;
}

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
       * `too_short` — fewer messages than the retain window, nothing to
       * collapse. `nothing_new` — everything outside the retain window is
       * already covered by the stored summary. `empty_summary` — the model
       * spent its budget reasoning and returned no text.
       */
      reason: "too_short" | "nothing_new" | "empty_summary";
    }
  | { status: "not_found" };

export async function compactConversation(
  conversationId: string,
  deps: CompactConversationDeps,
): Promise<CompactConversationResult> {
  const conversation = await deps.runInTx((tx) =>
    deps.agentStore.getConversation(tx, conversationId),
  );
  if (!conversation) return { status: "not_found" };
  const profile = await deps.runInTx((tx) =>
    deps.agentStore.getProfile(tx, conversation.profileId),
  );
  if (!profile) return { status: "not_found" };

  const { messages, messageIds } = await loadTurnHistory(
    { runInTx: deps.runInTx, agentStore: deps.agentStore },
    { conversationId },
  );

  // Same split the budget-triggered strategy would pick, so a manual
  // compaction and an automatic one cover comparable spans.
  const splitIdx = snapToPairBoundary(messages, Math.max(0, messages.length - DEFAULT_KEEP_TURNS));
  if (splitIdx <= 0) return { status: "skipped", reason: "too_short" };

  const throughMessageId = summaryCutoffFor(messageIds, splitIdx);
  if (throughMessageId === null) return { status: "skipped", reason: "nothing_new" };

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

  const response = await provider.chat({
    model,
    system,
    messages: [...messages.slice(0, splitIdx), { role: "user", content: SUMMARIZATION_PROMPT }],
    maxTokens: Math.min(16_000, limits.maxOutputTokens),
  });
  const summary = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (summary.trim().length === 0) return { status: "skipped", reason: "empty_summary" };

  await deps.runInTx((tx) =>
    deps.agentStore.insertOrRecoverSummary(tx, {
      conversationId,
      summary,
      throughMessageId,
      messagesSummarized: splitIdx,
      model,
      source: "manual",
    }),
  );

  return {
    status: "compacted",
    messagesSummarized: splitIdx,
    messagesKept: messages.length - splitIdx,
    model,
  };
}
