/**
 * Auto-repair cooldown writer. Listens for `conversation/errored` and
 * writes the next `cooldown_state` blob so `handle-message`'s entry guard
 * starts skipping inbounds until the cooldown elapses.
 *
 * Triggered by `handle-message.onFailure` after Inngest retries exhaust
 * (or immediately on a `NonRetriableError`). Bus-level dedup on
 * `id: "errored-${runId}"` ensures one run per `runId` even when both
 * `onFailure` and the worker-death reconcile path emit for the same
 * failed turn (see design/agent-resilience.md → Triggers).
 *
 * Read-modify-write: reads the prior blob (if any), feeds it to
 * `nextCooldownState` (60s base → 2× → 1h cap), writes the result.
 * REPEATABLE READ keeps the read/write consistent; the transactor's
 * once-retry covers the 40001 case if a second errored event somehow
 * slips past bus dedup.
 *
 * `retries: 0` — one shot per failure event. If this function itself
 * fails mid-run, Inngest's standard alerting catches it; we don't want
 * a recovery cascade.
 */

import type { Transactor } from "../db/index.js";
import { inngest } from "../inngest/client.js";
import { conversationErrored } from "../inngest/events.js";
import { logger } from "../logger.js";
import { nextCooldownState } from "./cooldown.js";
import type { AgentStore } from "./store/index.js";

export interface RecoverConversationDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

export function createRecoverConversation(deps: RecoverConversationDeps) {
  const { runInTx, agentStore } = deps;

  return inngest.createFunction(
    {
      id: "recover-conversation",
      triggers: [conversationErrored],
      retries: 0,
      concurrency: { limit: 1, key: "event.data.conversationId" },
    },
    async ({ event, step }) => {
      const { conversationId, errorClass, causeClass, errorMessage } = event.data;

      const result = await step.run("write-cooldown", async () => {
        return runInTx(async (tx) => {
          const conv = await agentStore.getConversation(tx, conversationId);
          if (!conv) {
            return { kind: "not_found" as const };
          }
          const next = nextCooldownState(conv.cooldownState, new Date());
          await agentStore.writeCooldownState(tx, conversationId, next);
          return { kind: "wrote" as const, state: next };
        });
      });

      if (result.kind === "not_found") {
        logger.warn(
          { conversationId, errorClass, errorMessage },
          "recover-conversation: conversation not found",
        );
        return { status: "skipped", reason: "conversation_not_found" };
      }

      logger.warn(
        {
          conversationId,
          errorClass,
          causeClass,
          errorMessage,
          cooldownSeconds: result.state.cooldownSeconds,
          consecutiveFailures: result.state.consecutiveFailures,
        },
        "recover-conversation: cooldown armed",
      );
      return {
        status: "cooldown_armed",
        cooldownSeconds: result.state.cooldownSeconds,
        consecutiveFailures: result.state.consecutiveFailures,
      };
    },
  );
}
