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
 * Coding tool gate — fired when Claude Code's stream-json control channel
 * surfaces a `permission_request` and the orchestrator's policy decides
 * to prompt the user (rather than auto-allowing or applying a logged
 * decision). Observability + audit only; the orchestrator's blocking wait
 * is on `coding/task/permission-decision`.
 */
export const codingTaskPermissionRequested = eventType("coding/task/permission-requested", {
  schema: z.object({
    taskId: z.string(),
    requestId: z.string(),
    tool: z.string(),
  }),
});

/**
 * Coding tool gate — user replied to the permission prompt via Telegram
 * inline keyboard (or a future Direct channel callback). The execute
 * orchestrator's `step.waitForEvent` resumes on this event. `requestId`
 * is the truncated form encoded in `callback_data` (≤16 chars); the
 * orchestrator's wait `if:` filter pins it to the in-flight request.
 */
export const codingTaskPermissionDecision = eventType("coding/task/permission-decision", {
  schema: z.object({
    taskId: z.string(),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]),
    scope: z.enum(["once", "task"]),
  }),
});

/**
 * Coding delegation — execute phase reached `pending_verify`. Triggers
 * the slice 4.0h `coding-task-verify` orchestrator function which runs
 * verify → push → draft PR. Emitted by the execute orchestrator after
 * the status transition committed durably; consumed exactly once per
 * task (Inngest dedup on the event id is implicit via task id).
 */
export const codingTaskCliDone = eventType("coding/task/cli-done", {
  schema: z.object({
    taskId: z.string(),
  }),
});

/**
 * Coding delegation — verify step finished. Observability only; the
 * `coding-task-verify` function continues with push + PR (or marks the
 * task failed) inline. Consumed by metrics + future replay tooling.
 */
export const codingTaskVerifyComplete = eventType("coding/task/verify-complete", {
  schema: z.object({
    taskId: z.string(),
    ok: z.boolean(),
    exitCode: z.number().int(),
    durationMs: z.number().int().nonnegative(),
  }),
});

/**
 * Coding delegation — `git push` succeeded. Observability + Telegram
 * delivery hook (slice 4.0c progress message can show "branch pushed"
 * before the PR opens, useful when octokit is slow). `branchSha` is the
 * head sha of the just-pushed branch.
 */
export const codingTaskPushed = eventType("coding/task/pushed", {
  schema: z.object({
    taskId: z.string(),
    branchSha: z.string(),
  }),
});

/**
 * Coding delegation — draft PR opened on GitHub. Consumed by the
 * Telegram adapter to post the final progress edit (`✅ PR opened: <url>`)
 * and by metrics / observer extraction.
 */
export const codingTaskPrOpened = eventType("coding/task/pr-opened", {
  schema: z.object({
    taskId: z.string(),
    prUrl: z.string().url(),
    prNumber: z.number().int().positive(),
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
