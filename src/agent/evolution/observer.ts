/**
 * Observer — post-conversation extraction. Inngest function triggered by
 * `conversation/idle`. Sequence per fire:
 *
 *   1. extract corrections from the transcript → steering rules (with
 *      optional consolidation when active rule count crosses threshold)
 *   2. extract facts from the transcript → Hindsight (with full
 *      network + compartment + trust tags)
 *   3. drain pending memories for the user → classify each → Hindsight
 *
 * Observer is the sole writer to Hindsight. The live `memory_retain`
 * tool stages into `pending_memories`; step 3 catches those rows up
 * during the same idle pass.
 */

import { NonRetriableError } from "inngest";
import type { Transactor } from "../../db/index.js";
import { inngest } from "../../inngest/client.js";
import { conversationIdle } from "../../inngest/events.js";
import { type LlmProviderResolver, ProviderConfigError } from "../../llm/resolver.js";
import { logger } from "../../logger.js";
import type { MemoryProvider } from "../../memory/provider.js";
import type { AgentStore } from "../store/index.js";
import { consolidateRules } from "./consolidate-rules.js";
import { buildRetainItems, classifyPendingMemories } from "./drain-pending-memories.js";
import { extractCorrections } from "./extract-corrections.js";
import { extractMemories } from "./extract-memories.js";

const MIN_MESSAGES_FOR_EXTRACTION = 4; // 2 turns minimum

/**
 * Max pending rows drained per Observer run. Caps the `step.run` output
 * payload so a post-migration backlog of thousands doesn't exceed
 * Inngest's run-state size limit. Remaining rows wait for the next
 * `conversation/idle` to drain.
 */
const PENDING_DRAIN_BATCH_SIZE = 100;

export interface ObserverDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  /**
   * Per-fire provider lookup. The extraction model is read from the
   * conversation's active profile inside the function (see `load-profile`
   * step), then handed to the resolver. The resolver's own per-model cache
   * amortizes the cost across fires. See `src/llm/resolver.ts`.
   */
  resolveProvider: LlmProviderResolver;
  // TODO: Route through Service.memory once retainBatch is on the Service interface (ACL boundary).
  // Currently called directly on the provider — safe because the Observer is a trusted internal consumer.
  memory: Pick<MemoryProvider, "retainBatch">;
}

export function createObserver(deps: ObserverDeps) {
  const { agentStore, resolveProvider } = deps;

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

      // Resolve evolution model from the conversation's profile at fire
      // time (not bootstrap) so a profile using a cheaper chat model gets
      // extraction on that model too. `extractionModel` overrides the
      // chat model when set; otherwise the chat model is reused.
      const profile = await step.run("load-profile", async () => {
        return deps.runInTx((tx) => agentStore.getProfile(tx, conv.profileId));
      });
      if (!profile) {
        logger.warn({ conversationId, profileId: conv.profileId }, "observer: profile not found");
        return { status: "skipped", reason: "profile_not_found" };
      }
      const model = profile.extractionModel ?? profile.model;

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

      // Resolve once per fire — outside `step.run` because the provider
      // instance isn't JSON-serializable. The resolver's own per-model
      // cache amortizes the cost across fires. Permanent config errors
      // (no routing row for the extraction model, missing secret) are
      // rewrapped as `NonRetriableError` so Inngest doesn't burn its
      // single retry on a misconfiguration; transient infra errors keep
      // their plain shape and follow the default retry path.
      let provider: Awaited<ReturnType<typeof resolveProvider>>;
      try {
        provider = await resolveProvider(model);
      } catch (err) {
        if (err instanceof ProviderConfigError) {
          throw new NonRetriableError(err.message, { cause: err });
        }
        throw err;
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

      // Phase 2: extract facts from the transcript into long-term memory
      const memoryResult = await step.run("extract-memories", async () => {
        return extractMemories(history, conv.userId, {
          provider,
          model,
          memory: deps.memory,
        });
      });

      // Phase 3: drain pending_memories — staged live retains and any
      // migration backfill — through the same classifier prompt. Split
      // across multiple step.runs so Inngest memoizes each: a delete
      // failure after a successful retain re-runs only the delete on
      // retry, not the LLM classifier or the retainBatch write.
      const pending = await step.run("load-pending-memories", async () => {
        return agentStore.getPendingMemories(conv.userId, PENDING_DRAIN_BATCH_SIZE);
      });

      let drainResult: { drained: number; byNetwork: Record<string, number> } = {
        drained: 0,
        byNetwork: {},
      };

      if (pending.length > 0) {
        const classified = await step.run("classify-pending-memories", async () => {
          return classifyPendingMemories(pending, { provider, model });
        });

        if (classified.successful.length > 0) {
          const items = buildRetainItems(classified.successful);
          await step.run("retain-pending-memories", async () => {
            await deps.memory.retainBatch(conv.userId, items);
          });
          await step.run("delete-pending-memories", async () => {
            await agentStore.deletePendingMemories(classified.successful.map((c) => c.id));
          });
          drainResult = {
            drained: classified.successful.length,
            byNetwork: classified.byNetwork,
          };
        }
      }

      return {
        status: "processed",
        conversationId,
        corrections: result,
        consolidation,
        memories: memoryResult,
        drained: drainResult,
      };
    },
  );
}
