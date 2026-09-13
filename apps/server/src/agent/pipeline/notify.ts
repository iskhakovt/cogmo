/**
 * Best-effort pipeline notices that keep their step's retries.
 *
 * `notifyConversation` already swallows per-session delivery failures, so what
 * can still throw is its session lookup — usually a transient DB error. The
 * catch therefore wraps the step, not its body: a failing notice is retried by
 * Inngest like any other step, and only one that failed permanently — the
 * `StepError` the SDK throws in the body — is dropped. A notice is never worth
 * failing a function that has already committed the run's state. Anything
 * else reaching the catch is a bug, and propagates.
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
): Promise<void> {
  try {
    await step.run(stepId, () => deliveryRouter.notifyConversation(conversationId, text));
  } catch (error) {
    if (!(error instanceof StepError)) throw error;
    log.warn({ err: error, conversationId, stepId }, "pipeline notice not delivered after retries");
  }
}
