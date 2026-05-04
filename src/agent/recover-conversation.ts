/**
 * Recovery function — listens for `conversation/errored` and attempts a
 * one-shot self-heal before giving up on the conversation.
 *
 * Triggered by the `onFailure` handler on `handle-message` after Inngest
 * retries exhaust (or immediately on a `NonRetriableError`).
 *
 * Strategy: load the conversation's history, run the invariant validator.
 * If repairs are needed, persist them via `applyHeal` and re-emit the
 * original `inbound/ready` so the user's failed turn gets another shot
 * against clean history. If no repairs are needed, the failure was
 * something else (programmer error, persistent provider auth issue, etc.)
 * and another attempt would just burn LLM calls — mark the conversation
 * `errored` so the orchestrator's status guard refuses further inbound.
 *
 * `retries: 0` — one shot per failure event. If this function itself fails
 * mid-run, Inngest's standard alerting catches it; we don't want a
 * recovery cascade.
 */

import { inngest } from "../inngest/client.js";
import { conversationErrored, inboundReady } from "../inngest/events.js";
import { logger } from "../logger.js";
import { computeHealPlan, isNoOp } from "./heal-plan.js";
import { validateHistory } from "./history-invariants.js";
import type { AgentStore } from "./store/index.js";

export interface RecoverConversationDeps {
  agentStore: AgentStore;
}

export function createRecoverConversation(deps: RecoverConversationDeps) {
  const { agentStore } = deps;

  return inngest.createFunction(
    {
      id: "recover-conversation",
      triggers: [conversationErrored],
      retries: 0,
      concurrency: { limit: 1, key: "event.data.conversationId" },
    },
    async ({ event, step }) => {
      const { conversationId, triggerInboundId, errorClass, causeClass, errorMessage } = event.data;

      const conv = await step.run("load-conversation", async () => {
        return agentStore.getConversation(conversationId);
      });
      if (!conv) {
        logger.warn(
          { conversationId, errorClass, errorMessage },
          "recover-conversation: conversation not found",
        );
        return { status: "skipped", reason: "conversation_not_found" };
      }

      // Already errored — earlier failure already gave up. Nothing to retry.
      if (conv.status === "errored") {
        return { status: "skipped", reason: "already_errored" };
      }

      const historyWithIds = await step.run("load-history", async () => {
        return agentStore.getHistoryWithIds(conversationId);
      });

      const validation = validateHistory(historyWithIds.map((r) => r.message));
      const plan = computeHealPlan(historyWithIds, validation.messages);

      if (isNoOp(plan)) {
        // Validator found nothing to repair — the original failure wasn't a
        // history-contract violation. Retrying would just hit the same
        // upstream error. Mark the conversation errored and stop spending.
        await step.run("mark-errored", async () => {
          await agentStore.setConversationStatus(conversationId, "errored");
        });
        logger.warn(
          { conversationId, errorClass, causeClass, errorMessage },
          "recover-conversation: no repair possible, marking conversation errored",
        );
        return { status: "marked_errored", reason: "no_repair_possible" };
      }

      // We have repairs. Apply them, then re-emit the original inbound/ready
      // so handle-message gets another shot against clean history. Heal rows
      // are stamped with the conversation's current profile model — same
      // shape `handle-message` would use for the retry's snapshot, so the
      // audit trail stays consistent. `lastInboundMessageId` falls back to
      // the failure event's `triggerInboundId` (preserved verbatim through
      // the failure pipeline), or to the empty string when even that is
      // unavailable (flush-style trigger).
      const profile = await step.run("load-profile", async () => {
        return agentStore.getProfile(conv.profileId);
      });
      if (!profile) {
        throw new Error(`Profile not found: ${conv.profileId}`);
      }
      const lastInboundFallback = triggerInboundId ?? "";

      await step.run("apply-heal", async () => {
        await agentStore.applyHeal({
          conversationId,
          supersededIds: plan.supersededIds,
          insertions: plan.insertions,
          profileId: conv.profileId,
          model: profile.model,
          lastInboundMessageId: lastInboundFallback,
        });
      });

      // Re-emit the original inbound/ready so the failed turn retries.
      // triggerInboundId may be null for flush-style triggers — preserved
      // verbatim so handle-message's staleness guard behaves identically
      // to the original attempt.
      await step.sendEvent(
        "retry-inbound-ready",
        inboundReady.create({ conversationId, triggerInboundId }),
      );

      logger.info(
        {
          conversationId,
          errorClass,
          causeClass,
          repairCount: validation.repairs.length,
          supersededCount: plan.supersededIds.length,
          insertedCount: plan.insertions.length,
        },
        "recover-conversation: heal applied, retrying inbound",
      );
      return { status: "retried", repairCount: validation.repairs.length };
    },
  );
}
