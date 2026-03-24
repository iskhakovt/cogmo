import { eventType } from "inngest";
import { z } from "zod";

/**
 * Fired when a user sends a message from any channel.
 * The orchestrator (handle-message) listens for this.
 * No conversationId — the orchestrator resolves it via the session manager.
 */
export const messageReceived = eventType("message/received", {
  schema: z.object({
    channel: z.string(),
    chatId: z.string(),
    userId: z.string(),
    text: z.string(),
  }),
});

/**
 * Fired when the orchestrator has a response ready.
 * Each channel has its own Inngest function that listens for this
 * and delivers the response through its native transport.
 */
export const messageResponse = eventType("message/response", {
  schema: z.object({
    conversationId: z.string(),
    channel: z.string(),
    chatId: z.string(),
    text: z.string(),
  }),
});
