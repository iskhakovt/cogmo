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
import { computeHealPlan, isNoOp, unknownPersistableKinds } from "./heal-plan.js";
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

      // Persistable-kinds gate. If the validator emitted any repair kind we
      // haven't explicitly evaluated as safe to commit, treat it as
      // "no repair possible" and mark errored — we can't safely retry here
      // because heal would skip persistence and the next turn's validator
      // would re-run the same in-memory repair, never converging.
      const unknown = unknownPersistableKinds(validation.repairs);
      if (unknown.length > 0) {
        logger.error(
          {
            conversationId,
            errorClass,
            causeClass,
            unknownKinds: unknown,
            repairs: validation.repairs,
          },
          "recover-conversation: validator emitted unknown repair kinds, marking errored",
        );
        await step.run("mark-errored", async () => {
          await agentStore.setConversationStatus(conversationId, "errored");
        });
        return { status: "marked_errored", reason: "unknown_repair_kind" };
      }

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
      // audit trail stays consistent. `lastInboundMessageId` inherits from
      // the last existing visible row's cursor: heal insertions don't
      // represent a new response, so they must not advance the cursor.
      // `historyWithIds` is non-empty here (validator only finds repairs
      // when there's something to validate); the `triggerInboundId`
      // fallback covers the impossible-but-typed case where the inherit
      // path returned undefined. Empty string is intentionally NOT a
      // fallback — `messages.last_inbound_message_id` is `uuid NOT NULL`
      // and PG rejects empty strings as invalid UUIDs.
      const profile = await step.run("load-profile", async () => {
        return agentStore.getProfile(conv.profileId);
      });
      if (!profile) {
        throw new Error(`Profile not found: ${conv.profileId}`);
      }
      const inheritedCursor = historyWithIds.at(-1)?.lastInboundMessageId;
      const healCursor = inheritedCursor ?? triggerInboundId;
      if (!healCursor) {
        // History was empty AND the failure event carried no triggerInboundId.
        // Validator should have returned no repairs in that case (nothing to
        // validate); reaching here means a logic error. Bail out to errored
        // rather than fabricate an invalid cursor.
        logger.error(
          { conversationId, errorClass, causeClass },
          "recover-conversation: no cursor available for heal, marking errored",
        );
        await agentStore.setConversationStatus(conversationId, "errored");
        return { status: "marked_errored", reason: "no_cursor_for_heal" };
      }

      await step.run("apply-heal", async () => {
        await agentStore.applyHeal({
          conversationId,
          supersededIds: plan.supersededIds,
          insertions: plan.insertions,
          profileId: conv.profileId,
          model: profile.model,
          lastInboundMessageId: healCursor,
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
