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

/**
 * Fired by `handle-message`'s `onFailure` handler after Inngest retries
 * exhaust. Distinct from `response/ready` so the Hindsight Observer never
 * sees errored turns (no user-facing assistant content was produced — feeding
 * the memory pipeline would dilute it with operational noise).
 *
 * Consumers (future): the recovery function in PR2 attempts a sanitize-and-
 * retry; the evolution reflector builds a failure-pattern corpus for
 * steering-rule auto-correction. PR1 only emits the event — no consumers
 * yet, intentionally.
 */
/**
 * Fired by `handle-message` when a turn exits via the degraded off-ramp:
 * either the in-loop Class C repair budget for a subtype exhausted, or
 * Class D loop-pathology / iteration-cap fingerprint tripped. Unlike
 * `conversation/errored`, the conversation stays `active` — the user got a
 * system-generated apology and can retry. See design/agent-resilience.md →
 * Off-ramps + Degraded reply.
 *
 * Emitted from inside the durable persist step that writes the degraded
 * assistant message, so exactly-once delivery is provided by the wrapping
 * `step.run` (same pattern as `conversation/errored` in `onFailure`). No
 * explicit idempotency `id` needed.
 *
 * `subtype` enumerates every degrade trigger the loop produces today
 * (`empty_end_turn`, `stream_truncation`, `refusal`) plus the Class D
 * triggers (`stuck_loop`, `stuck_loop_cumulative`) and the iteration-cap
 * backstop. Nullable so future un-tagged degrade callsites stay
 * representable without widening the union; today every emission carries
 * a tag.
 */
export const conversationDegraded = eventType("conversation/degraded", {
  schema: z.object({
    conversationId: z.string(),
    runId: z.string(),
    triggerInboundId: z.string().nullable(),
    subtype: z
      .enum([
        "empty_end_turn",
        "stream_truncation",
        "refusal",
        "stuck_loop",
        "stuck_loop_cumulative",
        "iteration_cap",
      ])
      .nullable(),
    reason: z.string(),
  }),
});

export const conversationErrored = eventType("conversation/errored", {
  schema: z.object({
    conversationId: z.string(),
    runId: z.string(),
    /**
     * The triggering inbound message id from the failing run, when known.
     * Forwarded so PR2's recovery function (and any future consumer) can
     * mark just the failing inbound rather than guessing scope. Null when
     * the originating event was a flush (no specific inbound).
     */
    triggerInboundId: z.string().nullable(),
    /**
     * Class of the error Inngest saw — typically `NonRetriableError`
     * because handle-message rewraps non-retriable provider errors before
     * throwing. Preserved for parity with the run's actual exit shape.
     */
    errorClass: z.string(),
    /**
     * Class of the underlying cause when present (e.g. `BadRequestError`,
     * `RateLimitError`). When `errorClass === "NonRetriableError"` this is
     * the upstream provider error class — the bucket the evolution
     * failure-reflector actually wants. Null when there's no `cause`.
     */
    causeClass: z.string().nullable(),
    errorMessage: z.string(),
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
 * Coding delegation — task entered the `failed` terminal state in any
 * orchestrator (plan, execute, verify). Cleanup subscribers (run-branch
 * deletion, future telemetry) consume this without re-checking the row.
 * `reason` mirrors the row's `failure_reason` so subscribers don't have
 * to fetch it. Emitted exactly once per terminal-failure transition;
 * the conditional UPDATE upstream guarantees idempotency.
 */
export const codingTaskFailed = eventType("coding/task/failed", {
  schema: z.object({
    taskId: z.string(),
    reason: z.string(),
  }),
});

/**
 * Coding delegation — weekly orphan-run-branch sweep fan-out. The cron
 * lists managed coding repos and emits one event per repo so each repo's
 * cleanup runs in its own retry/observability lane (per Inngest's fan-out
 * idiom). Per-repo handlers query origin for `cogmo/run/*` refs, join with
 * the `coding_tasks` table, and delete refs whose task row is terminal +
 * older than 7 days OR has no row at all.
 */
export const codingRunBranchSweepRepo = eventType("coding/run-branch-sweep/repo", {
  schema: z.object({
    repoId: z.string(),
  }),
});

/**
 * Skills deploy gate — `register` produced an `approve`-tier deploy that
 * needs human signoff before main is advanced. Emitted by Service.skills
 * after the runner returns `pending_approval`. The per-channel Telegram
 * function consumes this and posts the Approve / Deny inline keyboard into
 * the originating conversation's active session. The keyboard's callback
 * tap dispatches directly to `transport.skills.approveDeploy` /
 * `denyDeploy` — no `step.waitForEvent` orchestration on the runner side
 * (the runner already returned).
 *
 * `pendingId` is the `skill_deploys.id` UUID; the per-channel Telegram
 * function fetches the manifest-derived details (declared effects, risk
 * tier, classifier log) from `skill_deploys` + `skills` at post time —
 * keeps the event payload minimal and avoids data duplication.
 */
export const skillsDeployApprovalRequested = eventType("skills/deploy/approval-requested", {
  schema: z.object({
    pendingId: z.string(),
    skillName: z.string(),
    gitSha: z.string(),
    conversationId: z.string(),
  }),
});

/**
 * One fire of a user/agent-defined scheduled task. Emitted by the
 * `scheduled-task-ticker` (1-min cron) for each row whose `next_run_at`
 * has passed and is still enabled. The fire handler builds a synthetic
 * conversation turn under the row's `userId` + `profileId` and replays
 * `prompt` as the user-role message into the agent loop. See
 * design/scheduling.md → Agent Self-Scheduling.
 *
 * The event `id` (set by the ticker, not in the schema) is
 * `${taskId}:${scheduledFor}` — Inngest dedup'es per id within its
 * window, so a ticker retry that re-emits the same row produces a no-op.
 *
 * `scheduledFor` is the timestamp the row was *supposed* to fire at —
 * threaded into the prompt by the fire handler so the model is
 * self-aware when the ticker is late (post-outage catch-up). It is NOT
 * the wall clock at emit time.
 */
export const scheduledTaskFire = eventType("agent/scheduled-task.fire", {
  schema: z.object({
    taskId: z.string(),
    userId: z.string(),
    profileId: z.string(),
    scheduledFor: z.string(), // ISO 8601 UTC
    prompt: z.string(),
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
    /**
     * Voice payload — present when the orchestrator has TTS'd the reply
     * and routed it via `DeliveryHandle.deliverVoice`.
     *
     * Voice rides on a *separate* `directOutbound` event with `content: ""`
     * (correlated to the just-delivered text by `platformAddress`). The
     * asymmetry vs. images — which ride on the same event as the rendered
     * text — is intentional: the orchestrator emits voice via a separate
     * `deliverVoice` call after the text has already streamed/finished,
     * so there is no single-emit point where both can be packed together.
     * Console clients should treat a content-empty + voice-present event
     * as "play the audio, don't render an empty bubble."
     */
    voice: z
      .object({
        data: z.string(), // base64
        mediaType: z.string(),
      })
      .optional(),
  }),
});
