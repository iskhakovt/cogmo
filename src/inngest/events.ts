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
 * Notification only — delivery is handled inline by the DeliveryRouter.
 * Consumed by: Observer (correction extraction), metrics, logging.
 */
export const responseReady = eventType("response/ready", {
  schema: z.object({
    conversationId: z.string(),
    messageId: z.string(),
  }),
});

/**
 * Fired when a conversation goes idle (no new messages after timeout).
 * The idle timer runs after each response/ready, cancelled by next inbound/arrived.
 * Consumed by: Observer (Stage 1 correction extraction, future memory extraction).
 */
export const conversationIdle = eventType("conversation/idle", {
  schema: z.object({
    conversationId: z.string(),
  }),
});

// --- Debounce events ---

export const debounceIdle = eventType("debounce/idle", {
  schema: z.object({
    conversationId: z.string(),
    inboundMessageId: z.string(),
    timeoutMs: z.number(),
  }),
});

export const debounceMaxwait = eventType("debounce/maxwait", {
  schema: z.object({
    conversationId: z.string(),
    inboundMessageId: z.string(),
    timeoutMs: z.number(),
  }),
});

export const debounceCancel = eventType("debounce/cancel", {
  schema: z.object({ conversationId: z.string() }),
});

export const inboundReady = eventType("inbound/ready", {
  schema: z.object({
    conversationId: z.string(),
    triggerInboundId: z.string().nullable(),
  }),
});

/**
 * Coding delegation — orchestrator entry point. The delegate_coding tool
 * (and any future automated trigger source) inserts a `coding_tasks` row
 * in `queued` status, then emits this event. The durable orchestrator
 * function (`createCodingOrchestrator`, registered in bootstrap when the
 * sandbox module is initialized) consumes it and runs the plan flow.
 */
export const codingTaskStart = eventType("coding/task/start", {
  schema: z.object({
    taskId: z.string(),
  }),
});

/**
 * Coding delegation — user approved the plan via the Telegram inline
 * keyboard (slice 2.0e). The execute orchestrator (slice 2.0f) consumes
 * this event and runs `claude --resume <sid> --permission-mode acceptEdits`
 * against the same task container.
 */
export const codingTaskPlanApproved = eventType("coding/task/plan-approved", {
  schema: z.object({
    taskId: z.string(),
    approvedAt: z.string(), // ISO timestamp
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
 *
 * `images` is included when the agent generated images (base64-encoded, since
 * events must serialize). Console clients opt into rendering.
 */
export const directOutbound = eventType("adapter/direct/outbound", {
  schema: z.object({
    platformAddress: z.string(),
    content: z.string(),
    images: z
      .array(
        z.object({
          data: z.string(), // base64
          mediaType: z.string(),
        }),
      )
      .optional(),
  }),
});
