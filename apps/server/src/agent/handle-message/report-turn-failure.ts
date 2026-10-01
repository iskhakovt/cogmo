import { buildConversationErroredEvent } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import type { TurnSteps } from "./turn-steps.js";

export interface TurnFailure {
  conversationId: string;
  triggerInboundId: string | null;
  /** The failed run's id. */
  runId: string;
  /** What Inngest saw; the original error class, if wrapped, is on `cause`. */
  error: Error;
}

/**
 * `handle-message`'s last-chance handler: retries are exhausted (or the run
 * failed non-retriably). Two responsibilities, ordered durable-first:
 *  1. Emit `conversation/errored` — the durable signal downstream consumers
 *     (recovery, evolution reflector) depend on. Must run even if user
 *     notification fails.
 *  2. Notify the user — best-effort courtesy. Wrapped so a failure in
 *     `notifyConversation` (DB outage on session lookup, etc.) can't
 *     propagate up and prevent step (1) from being recorded.
 * The original turn's `delivery` handle is gone (closure scope of a different
 * run), so sessions are re-resolved via `notifyConversation`.
 *
 * Steps, in order: `emit-conversation-errored`, `notify-user`.
 */
export async function reportTurnFailure(
  step: TurnSteps,
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">,
  failure: TurnFailure,
): Promise<void> {
  const { conversationId, triggerInboundId, runId, error } = failure;
  const turnLogger = logger.child({ runId, conversationId });
  // `error` is what Inngest saw — typically NonRetriableError, since
  // non-retriable provider errors are rewrapped. The original
  // class (BadRequestError, RateLimitError, etc.) is on `cause`.
  // Surface both so the evolution failure-reflector can bucket by
  // upstream class rather than every error coalescing to one bucket.
  const cause = error.cause;
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
  await step.run("notify-user", async () => {
    try {
      await deliveryRouter.notifyConversation(
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
