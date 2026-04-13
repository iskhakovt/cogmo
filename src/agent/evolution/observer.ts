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
import type { AgentStore } from "../store/index.js";
import { consolidateRules } from "./consolidate-rules.js";
import { extractCorrections } from "./extract-corrections.js";

const DEFAULT_EXTRACTION_MODEL = "claude-sonnet-4-20250514";
const MIN_MESSAGES_FOR_EXTRACTION = 4; // 2 turns minimum

export interface ObserverDeps {
  agentStore: AgentStore;
  provider: LlmProvider;
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

      if (result.consolidationNeeded) {
        await step.run("consolidate-rules", async () => {
          return consolidateRules(conv.profileId, {
            provider,
            model,
            store: agentStore,
          });
        });
      }

      return { status: "processed", conversationId, ...result };
    },
  );
}
