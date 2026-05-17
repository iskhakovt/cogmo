import { inngest } from "../inngest/client.js";
import { conversationIdle, inboundArrived, responseReady } from "../inngest/events.js";

/**
 * Idle timer — emits `conversation/idle` after the conversation has been
 * quiet for `idleTimeoutMs`.
 *
 * Triggered by `response/ready` (after each agent response); cancelled by
 * `inbound/arrived` (user sends a new message) so the sleep resets.
 *
 * Engagement is a conversation property, not a session property. The timer
 * never closes sessions — `channel_sessions.status` records reachability,
 * which is unrelated to whether the user is mid-conversation. Lazy
 * rotation in `Transport.resolveSession` handles "next inbound after idle
 * starts a fresh conversation"; this function's only job is to fire the
 * Observer trigger. See design/transport/sessions.md.
 */
export function createIdleTimer(deps: { idleTimeoutMs: number }) {
  const { idleTimeoutMs } = deps;

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

      await step.sendEvent("emit-idle", conversationIdle.create({ conversationId }));

      return { status: "idle" as const, conversationId };
    },
  );
}
