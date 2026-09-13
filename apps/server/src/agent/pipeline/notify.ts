/**
 * Best-effort pipeline notices that keep their step's retries.
 *
 * `notifyConversation` already swallows per-session delivery failures, so what
 * can still throw is its session lookup — usually a transient DB error. The
 * catch therefore wraps the step, not its body: a failing notice is retried by
 * Inngest like any other step, and only one that failed permanently reaches
 * the catch, where dropping the notice is the designed outcome. A notice is
 * never worth failing a function that has already committed the run's state.
 */

import { logger } from "../../logger.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";

const log = logger.child({ component: "pipeline.notify" });

export async function notifyAfterRetries(
  run: (id: string, body: () => Promise<unknown>) => Promise<unknown>,
  stepId: string,
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    await run(stepId, () => deliveryRouter.notifyConversation(conversationId, text));
  } catch (error) {
    log.warn({ err: error, conversationId, stepId }, "pipeline notice not delivered after retries");
  }
}
