import type { Durable } from "../../inngest/durable.js";
import { buildConversationErroredEvent } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import { failureCause } from "../turn-step-runner.js";
import {
  type MarkRejectedAttachmentsDeps,
  markRejectedAttachments,
} from "./mark-rejected-attachments.js";

export interface ReportTurnFailureDeps extends MarkRejectedAttachmentsDeps {
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
}

export interface TurnFailure {
  conversationId: string;
  triggerInboundId: string | null;
  /** The failed run's id. */
  runId: string;
  /** What Inngest saw; `failureCause` reads the error it wrapped. */
  error: Error;
}

/**
 * `handle-message`'s last-chance handler: retries are exhausted (or the run
 * failed non-retriably). Three responsibilities, ordered durable-first:
 *  1. Emit `conversation/errored` — the durable signal downstream consumers
 *     (recovery, evolution reflector) depend on. Must run even if user
 *     notification fails.
 *  2. On a provider's 400 or 413 to the turn's first request, mark its
 *     attachments rejected, before the user is told to try again.
 *  3. Notify the user — best-effort courtesy. Wrapped so a failure in
 *     `notifyConversation` (DB outage on session lookup, etc.) can't
 *     propagate up and prevent step (1) from being recorded.
 * The original turn's `delivery` handle is gone (closure scope of a different
 * run), so sessions are re-resolved via `notifyConversation`.
 *
 * Steps, in order: `emit-conversation-errored`, `mark-rejected-attachments`
 * (on such a refusal), `notify-user`.
 */
export async function reportTurnFailure(
  step: Durable,
  deps: ReportTurnFailureDeps,
  failure: TurnFailure,
): Promise<void> {
  const { conversationId, triggerInboundId, runId, error } = failure;
  const turnLogger = logger.child({ runId, conversationId });
  // `error` is what Inngest saw — typically NonRetriableError, since
  // non-retriable provider errors are rewrapped. The original
  // class (BadRequestError, RateLimitError, etc.) is what `failureCause`
  // returns, with the provider's refusal when there was one. Surface both
  // classes so the evolution failure-reflector can bucket by upstream class
  // rather than every error coalescing to one bucket.
  const { refusal, cause } = failureCause(error);
  const causeClass = cause instanceof Error ? cause.name : null;
  // Bus-level dedup with the worker-death reconcile (subscriber on
  // `inngest/function.failed`). Both emit `conversation/errored`
  // via `buildConversationErroredEvent`, which bakes in
  // `id: "errored-${runId}"`. Inngest's event-id dedup window
  // ensures `recover-conversation` runs exactly once even when
  // both paths fire for the same failed run. See
  // `src/inngest/events.ts → buildConversationErroredEvent` and
  // `design/agent-resilience.md → Triggers`.
  await step.sendEvent(
    "emit-conversation-errored",
    buildConversationErroredEvent({
      conversationId,
      runId,
      triggerInboundId,
      errorClass: error.name,
      causeClass,
      errorMessage: error.message,
    }),
  );
  await markRejectedAttachments(step, deps, { conversationId, refusal, turnLogger });
  await step.run("notify-user", async () => {
    try {
      await deps.deliveryRouter.notifyConversation(
        conversationId,
        "I hit an error processing your last message and won't keep retrying. Please try again.",
      );
    } catch (notifyErr) {
      turnLogger.error(
        { err: notifyErr },
        "onFailure: notifyConversation failed, conversation/errored already emitted",
      );
    }
  });
}
