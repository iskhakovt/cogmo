/**
 * Best-effort pipeline notice that keeps its step's retries. The catch wraps
 * the step, so only a notice that failed permanently (`StepError`) is logged
 * and dropped: a notice is never worth failing a function that has already
 * committed the run's state. Anything else propagates.
 */

import { StepError } from "inngest";
import { logger } from "../../logger.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";

const log = logger.child({ component: "pipeline.notify" });

/** The part of Inngest's `step` a notice uses. */
export interface NoticeStep {
  run(id: string, body: () => Promise<unknown>): Promise<unknown>;
}

export async function notifyAfterRetries(
  step: NoticeStep,
  stepId: string,
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">,
  conversationId: string,
  text: string,
  /** Identifies the run behind the notice in the drop log (run id, gate key, stage). */
  logContext: Readonly<Record<string, string | number>>,
): Promise<void> {
  try {
    await step.run(stepId, () => deliveryRouter.notifyConversation(conversationId, text));
  } catch (error) {
    if (!(error instanceof StepError)) throw error;
    log.warn(
      { ...logContext, err: error, conversationId, stepId },
      "pipeline notice not delivered after retries",
    );
  }
}
