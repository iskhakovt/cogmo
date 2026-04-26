/**
 * Observer — post-conversation correction extraction.
 *
 * Inngest function triggered by conversation/idle. Loads the transcript,
 * extracts behavioral corrections via chatTyped(), persists them as
 * steering rules, and optionally consolidates when the rule count
 * exceeds the threshold.
 *
 * This is the first consumer of the conversation/idle event.
 * Future phases will add memory extraction (Hindsight) as additional steps.
 */

import { inngest } from "../../inngest/client.js";
import { conversationIdle } from "../../inngest/events.js";
import type { LlmProvider } from "../../llm/provider.js";
import { logger } from "../../logger.js";
import type { MemoryProvider } from "../../memory/provider.js";
import type { AgentStore } from "../store/index.js";
import { consolidateRules } from "./consolidate-rules.js";
import { extractCorrections } from "./extract-corrections.js";
import { extractMemories } from "./extract-memories.js";

const DEFAULT_EXTRACTION_MODEL = "claude-sonnet-4-20250514";
const MIN_MESSAGES_FOR_EXTRACTION = 4; // 2 turns minimum

export interface ObserverDeps {
  agentStore: AgentStore;
  provider: LlmProvider;
  // TODO: Route through Service.memory once retainBatch is on the Service interface (ACL boundary).
  // Currently called directly on the provider — safe because the Observer is a trusted internal consumer.
  memory: Pick<MemoryProvider, "retainBatch">;
  extractionModel?: string;
}

export function createObserver(deps: ObserverDeps) {
  const { agentStore, provider } = deps;
  const model = deps.extractionModel ?? DEFAULT_EXTRACTION_MODEL;

  return inngest.createFunction(
    {
      id: "observer",
      triggers: [conversationIdle],
      retries: 1,
      concurrency: { limit: 1, key: "event.data.conversationId" },
    },
    async ({ event, step }) => {
      const { conversationId } = event.data;

      const conv = await step.run("load-conversation", async () => {
        return agentStore.getConversation(conversationId);
      });
      if (!conv) {
        logger.warn({ conversationId }, "observer: conversation not found");
        return { status: "skipped", reason: "conversation_not_found" };
      }

      const history = await step.run("load-history", async () => {
        return agentStore.getHistory(conversationId);
      });

      if (history.length < MIN_MESSAGES_FOR_EXTRACTION) {
        logger.debug(
          { conversationId, messageCount: history.length },
          "observer: conversation too short for extraction",
        );
        return { status: "skipped", reason: "too_short" };
      }

      const result = await step.run("extract-corrections", async () => {
        return extractCorrections(history, conv.profileId, {
          provider,
          model,
          store: agentStore,
        });
      });

      const consolidation = result.consolidationNeeded
        ? await step.run("consolidate-rules", () =>
            consolidateRules(conv.profileId, { provider, model, store: agentStore }),
          )
        : null;

      // Phase 2: extract facts into long-term memory
      const memoryResult = await step.run("extract-memories", async () => {
        return extractMemories(history, conv.userId, {
          provider,
          model,
          memory: deps.memory,
        });
      });

      return {
        status: "processed",
        conversationId,
        corrections: result,
        consolidation,
        memories: memoryResult,
      };
    },
  );
}
