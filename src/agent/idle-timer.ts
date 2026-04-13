import { inngest } from "../inngest/client.js";
import { conversationIdle, inboundArrived, responseReady } from "../inngest/events.js";
import { logger } from "../logger.js";
import type { TransportStore } from "../transport/store/index.js";

/**
 * Idle timer — detects when a conversation goes quiet.
 *
 * Triggered by response/ready (after each agent response).
 * Sleeps for the idle timeout, then closes sessions and emits conversation/idle.
 * Cancelled by inbound/arrived (user sends a new message) — resets the timer.
 *
 * The conversation/idle event triggers the Observer for correction
 * extraction (Stage 1) and future memory extraction.
 */
export function createIdleTimer(deps: { idleTimeoutMs: number; transportStore: TransportStore }) {
  const { idleTimeoutMs, transportStore } = deps;

  return inngest.createFunction(
    {
      id: "idle-timer",
      triggers: [responseReady],
      cancelOn: [{ event: inboundArrived, match: "data.conversationId" }],
      concurrency: { limit: 1, key: "event.data.conversationId" },
    },
    async ({ event, step }) => {
      const { conversationId } = event.data;

      const minutes = Math.round(idleTimeoutMs / 60_000);
      await step.sleep("idle-wait", `${minutes}m`);

      // Timer fired — conversation is idle
      await step.run("close-sessions", async () => {
        const sessions = await transportStore.getActiveSessionsForConversation(conversationId);
        for (const session of sessions) {
          await transportStore.closeSession(session.id);
        }
        logger.info(
          { conversationId, sessionsClosed: sessions.length },
          "conversation idle — sessions closed",
        );
      });

      await step.sendEvent("emit-idle", conversationIdle.create({ conversationId }));

      return { status: "idle", conversationId };
    },
  );
}
