import { inngest } from "../inngest/client.js";
import { conversationIdle, inboundArrived, responseReady } from "../inngest/events.js";

/**
 * Idle timer — emits `conversation/idle` after `idleTimeoutMs` of silence.
 * Triggered by `response/ready`; cancelled by `inbound/arrived` so the
 * sleep resets when the user sends a new message. See
 * design/transport/sessions.md for why engagement is conversation-level
 * and not encoded on `channel_sessions.status`.
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
