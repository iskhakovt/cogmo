import { eventType } from "inngest";
import { z } from "zod";

/**
 * Fired when an adapter has persisted an inbound message.
 * The orchestrator (handle-message) listens for this.
 * Adapter has already resolved the session and persisted the inbound —
 * the orchestrator receives IDs, not raw content.
 */
export const inboundArrived = eventType("inbound/arrived", {
  schema: z.object({
    conversationId: z.string(),
    inboundMessageId: z.string(),
  }),
});

/**
 * Fired when the orchestrator has persisted an assistant response.
 * Respond functions listen for this and deliver via channel adapters.
 */
export const responseReady = eventType("response/ready", {
  schema: z.object({
    conversationId: z.string(),
    messageId: z.string(),
  }),
});

/**
 * Direct channel — external clients emit this to send messages.
 * The direct-inbound Inngest function translates to inbound/arrived.
 */
export const directInbound = eventType("adapter/direct/inbound", {
  schema: z.object({
    platformAddress: z.string(),
    text: z.string(),
    platformTs: z.string(), // ISO timestamp
  }),
});

/**
 * Direct channel — emitted when a response is ready for a direct-channel session.
 * External clients can poll for this or use DB polling.
 */
export const directOutbound = eventType("adapter/direct/outbound", {
  schema: z.object({
    platformAddress: z.string(),
    content: z.string(),
  }),
});
