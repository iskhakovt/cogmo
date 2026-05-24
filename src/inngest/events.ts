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

export type InboundArrivedData = z.infer<typeof inboundArrived.schema>;

/**
 * Build an `inbound/arrived` event payload with a bus-dedup `id` keyed on
 * the inbound message — used wherever the emit may be retried after a
 * partial-progress failure (e.g. `resolveBoundary` emits N events in a
 * loop; an Inngest step.run retry after a mid-loop crash would re-emit
 * already-sent ones without this dedup). One inbound row, one router run,
 * regardless of how many times the emit path retries.
 *
 * `transport.emit` doesn't go through here because its emit is a single
 * send after a single insert — there's no partial-progress shape to
 * idempotently retry.
 */
export function buildInboundArrivedEvent(data: InboundArrivedData) {
  return { ...inboundArrived.create(data), id: `inbound-arrived-${data.inboundMessageId}` };
}

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
 * Emitted via `step.sendEvent` right after the durable persist step that
 * writes the degraded assistant message — same pattern as
 * `conversation/errored` in `onFailure`. Inngest's bus-level dedup on the
 * named step provides exactly-once delivery; no explicit idempotency `id`
 * needed.
 *
 * `subtype` carries the classifier verdict when the loop exited through a
 * Class C / D tagged off-ramp (`empty_end_turn`, `stream_truncation`,
 * `refusal`, `stuck_loop`, `stuck_loop_cumulative`). It is `null` when the
 * loop exited via the iteration-cap backstop — that path has no classifier
 * subtype; `reason: "iteration_cap"` carries the distinguishing label.
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

/**
 * Type alias for the `conversation/errored` event data shape — both
 * emitters import this so changes to the schema propagate without an
 * `as` cast.
 */
export type ConversationErroredData = z.infer<typeof conversationErrored.schema>;

/**
 * Build a `conversation/errored` event payload with the bus-level dedup
 * `id` baked in. Both emitters — `handle-message`'s `onFailure` and the
 * `handle-message-reconcile` subscriber on `inngest/function.failed` —
 * MUST go through this helper. Inngest's event-id dedup window then
 * ensures `recover-conversation` runs exactly once per failed run no
 * matter which path observed the failure first (or whether both fired).
 *
 * Without the shared helper, the two emitters can drift — and silently:
 * neither file's tests can see that the OTHER emitter is missing the
 * id. The contract is two-sided, so the implementation must be too.
 *
 * `id: "errored-${runId}"` is the canonical shape; the
 * `recover-conversation` consumer also documents this format. Don't
 * change the prefix without updating both emitters AND the dedup
 * regression test in `recover-conversation-dedup.test.ts`.
 */
export function buildConversationErroredEvent(data: ConversationErroredData) {
  return {
    ...conversationErrored.create(data),
    id: `errored-${data.runId}`,
  };
}

// --- Auto-repair cooldown telemetry ---

/**
 * Discriminator for `conversation/cooldown/entered.causeClass`.
 * Matches `design/agent-resilience.md` → Failure taxonomy:
 *  - `"A"` — transport/infra transient that exhausted Inngest retries
 *    (also covers worker-disconnect via the reconcile path).
 *  - `"B"` — provider-permanent / non-retriable (rewrapped as
 *    `NonRetriableError` upstream).
 *  - `"invariant"` — history-invariant violation.
 *  - `"bug"` — programmer-bug exception or otherwise unclassified.
 *
 * Class C and D do NOT trigger cooldown so they never appear here.
 */
export const cooldownCauseClass = ["A", "B", "invariant", "bug"] as const;
export type CooldownCauseClass = (typeof cooldownCauseClass)[number];

/**
 * Map the `conversation/errored.errorClass` field onto the
 * `causeClass` taxonomy. v1 mapping:
 *  - `"NonRetriableError"` → `"B"`
 *  - `"WorkerDeath"` (injected by `handle-message-reconcile`) → `"A"`
 *  - else → `"bug"` (residual bucket — covers retriable-class errors
 *    that exhausted Inngest retries AND history-invariant violations
 *    that don't have a typed Error class today).
 *
 * Refine when a typed `HistoryInvariantError` lands and/or when
 * retriable-class names need to map to `"A"` precisely.
 */
export function deriveCauseClass(errorClass: string): CooldownCauseClass {
  if (errorClass === "NonRetriableError") return "B";
  if (errorClass === "WorkerDeath") return "A";
  return "bug";
}

/**
 * Fires every time `recover-conversation` writes `cooldown_state`
 * (initial arm or doubled-on-half-open-failure). Subscribers: evolution
 * failure-reflector, future alerting / metrics sinks. Pairs with
 * `conversation/cooldown/cleared`.
 *
 * See `design/agent-resilience.md` → Telemetry.
 */
export const conversationCooldownEntered = eventType("conversation/cooldown/entered", {
  schema: z.object({
    conversationId: z.string(),
    /** The failed `handle-message` run that triggered the cooldown write. */
    runId: z.string(),
    lastErroredAt: z.string().datetime({ offset: true }),
    cooldownSeconds: z.number().int().positive(),
    consecutiveFailures: z.number().int().positive(),
    causeClass: z.enum(cooldownCauseClass),
  }),
});

export type ConversationCooldownEnteredData = z.infer<typeof conversationCooldownEntered.schema>;

/**
 * Build a `conversation/cooldown/entered` event payload with a bus-level
 * dedup `id` baked in. `id: "cooldown-entered-${runId}"` keys on the
 * failed run that triggered the cooldown write — so an Inngest retry
 * of the `recover-conversation` function (or any future second emitter)
 * for the same failed run is deduplicated at the bus.
 */
export function buildConversationCooldownEnteredEvent(data: ConversationCooldownEnteredData) {
  return {
    ...conversationCooldownEntered.create(data),
    id: `cooldown-entered-${data.runId}`,
  };
}

/**
 * Discriminator for `conversation/cooldown/cleared.clearedBy`.
 * Matches `design/agent-resilience.md` → Clear triggers.
 *
 * `secrets_rotated` is reserved — the `/secrets rotate` clear trigger
 * is a deferred follow-up; the value is in the union today so
 * subscribers don't need a schema change when that command ships.
 */
export const cooldownClearedBy = [
  "success",
  "model_switch",
  "profile_switch",
  "user_repair",
  "secrets_rotated",
] as const;
export type CooldownClearedBy = (typeof cooldownClearedBy)[number];

/**
 * Fires when `cooldown_state` clears (success past the threshold,
 * `/repair`, `/model`, `/profile`, future `/secrets rotate`). Pairs
 * with `conversation/cooldown/entered`.
 *
 * `elapsedCooldownSeconds` is the wall-clock distance from
 * `cooldown_state.lastErroredAt` to the clear moment. Can be less than
 * the prior `cooldownSeconds` (e.g. `/repair` mid-window) OR greater
 * (e.g. half-open probe ran after the window elapsed). Subscribers
 * compare against the prior `entered` event's `cooldownSeconds` if
 * they want to discriminate the two.
 *
 * See `design/agent-resilience.md` → Telemetry.
 */
export const conversationCooldownCleared = eventType("conversation/cooldown/cleared", {
  schema: z.object({
    conversationId: z.string(),
    clearedBy: z.enum(cooldownClearedBy),
    elapsedCooldownSeconds: z.number().nonnegative(),
  }),
});

export type ConversationCooldownClearedData = z.infer<typeof conversationCooldownCleared.schema>;

/**
 * Wall-clock seconds from a cooldown's `lastErroredAt` anchor to now.
 * Shared by every clear-site so the elapsed math can't drift between
 * `handle-message`'s success-path emit and the transport-side emits.
 *
 * `Math.max(0, ...)` guards against clock skew on hosts whose system
 * clock moved backward between the cooldown write and the clear (NTP
 * step, VM clock drift). Downstream consumers can assume the field is
 * non-negative even under adversarial timing.
 */
export function calculateElapsedCooldown(lastErroredAt: string): number {
  return Math.max(0, (Date.now() - Date.parse(lastErroredAt)) / 1000);
}

/**
 * Build a `conversation/cooldown/cleared` event payload with a
 * required bus-dedup `id`. Mirrors `buildConversationErroredEvent` and
 * `buildConversationCooldownEnteredEvent` — the dedup contract is
 * symmetric across all `conversation/*` events, and a missing id is
 * always a bug in the caller (Inngest's at-least-once delivery on
 * `step.sendEvent` would otherwise produce duplicate events; same risk
 * for caller-side retries through `inngest.send`).
 *
 * Canonical id shape: `cooldown-cleared-${conversationId}-${lastErroredAt}`
 * — keys on the specific cooldown being cleared. Two paths attempting
 * to clear the same cooldown (theoretical race; in practice the second
 * sees `priorState === null` and skips) dedup to one event.
 */
export function buildConversationCooldownClearedEvent(
  data: ConversationCooldownClearedData,
  id: string,
) {
  return { ...conversationCooldownCleared.create(data), id };
}

// --- Boundary hold events ---

/**
 * The Telegram adapter has stashed an inbound in `boundary_pending` and
 * sent the user a "Resume previous / Start fresh" prompt. The waiter
 * function (`boundary-waiter`) consumes this and starts the timeout.
 * `cancelOn` `boundary/resolved` ends the wait early when the user taps
 * a button (or runs `/new` / `/resume` while the hold is open).
 *
 * Dedup id is `boundary-pending-${boundaryId}` so a retry of the
 * boundary-creating tx (Inngest at-least-once) doesn't start two waiters.
 */
export const boundaryPendingEvent = eventType("conversation/boundary/pending", {
  schema: z.object({
    boundaryId: z.string(),
    channelId: z.string(),
    platformAddress: z.string(),
    timeoutMs: z.number().int().positive(),
  }),
});

export type BoundaryPendingData = z.infer<typeof boundaryPendingEvent.schema>;

export function buildBoundaryPendingEvent(data: BoundaryPendingData) {
  return { ...boundaryPendingEvent.create(data), id: `boundary-pending-${data.boundaryId}` };
}

/**
 * Fired when a boundary hold has been resolved — by user button tap,
 * by `/new` or `/resume` during the hold, or by waiter timeout falling
 * back to "fresh." Cancels the waiter (`cancelOn`) and is observability
 * for downstream consumers (no orchestrator dependency yet).
 *
 * `resolvedConversationId` carries the conversation the buffered inbounds
 * landed in — the prior id for `resume`/`resume_target`, a freshly
 * created id for `fresh`/`waiter_timeout`.
 */
export const boundaryResolvedReason = [
  "user_resume",
  "user_resume_target",
  "user_fresh",
  "user_command",
  "waiter_timeout",
] as const;
export type BoundaryResolvedReason = (typeof boundaryResolvedReason)[number];

export const boundaryResolvedEvent = eventType("conversation/boundary/resolved", {
  schema: z.object({
    boundaryId: z.string(),
    channelId: z.string(),
    platformAddress: z.string(),
    resolvedConversationId: z.string(),
    reason: z.enum(boundaryResolvedReason),
    drainedInboundCount: z.number().int().nonnegative(),
  }),
});

export type BoundaryResolvedData = z.infer<typeof boundaryResolvedEvent.schema>;

export function buildBoundaryResolvedEvent(data: BoundaryResolvedData) {
  return { ...boundaryResolvedEvent.create(data), id: `boundary-resolved-${data.boundaryId}` };
}

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
 * this event and runs `claude --resume <sid> --permission-mode bypassPermissions`
 * against the same task container.
 */
export const codingTaskPlanApproved = eventType("coding/task/plan-approved", {
  schema: z.object({
    taskId: z.string(),
    approvedAt: z.string(), // ISO timestamp
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
 * Inngest system event — fires environment-wide on every terminal-failed
 * function run. The shape mirrors `FailureEventPayload` from `inngest`
 * (kept as a parallel Zod declaration here so we can name it as a trigger
 * without depending on the SDK's `internalEvents` constants at the
 * trigger callsite).
 *
 * Cogmo subscribes to this in the `coding-task-reconcile` function — see
 * design/coding-delegation.md → Worker-death reconciliation. `onFailure`
 * is not a reliable substitute on Inngest connect-mode worker death
 * ([inngest/inngest#3549](https://github.com/inngest/inngest/issues/3549));
 * this system event fires regardless of how the worker exited.
 *
 * Schema is permissive (`passthrough()` for the inner event payload and
 * the error blob) because the inner shape varies by triggering function.
 * Subscribers narrow on `function_id` and the inner `data` fields they
 * need: coding reconcile reads `data.event.data.taskId`; the
 * `handle-message` reconcile reads `data.event.data.conversationId` and
 * `data.event.data.triggerInboundId`. Each consumer's declared fields
 * stay optional here so the schema accepts every triggering event shape
 * without dropping anything to passthrough.
 */
export const inngestFunctionFailed = eventType("inngest/function.failed", {
  schema: z.object({
    function_id: z.string(),
    run_id: z.string(),
    error: z
      .object({
        message: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough(),
    event: z
      .object({
        name: z.string(),
        data: z
          .object({
            taskId: z.string().optional(),
            conversationId: z.string().optional(),
            triggerInboundId: z.string().nullable().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
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
 * One fire of a skill whose manifest declared a `schedule:` cron expression.
 * Emitted by the `skill-cron-ticker` (1-min cron) for each row whose
 * `next_run_at` has passed and that is not disabled. The fire handler resolves
 * the skill by id, no-ops if it has been disabled/deregistered since the tick
 * locked the row, and otherwise invokes the skill with empty inputs.
 *
 * The event `id` (set by the ticker, not in the schema) is
 * `${skillId}:${scheduledFor}` — Inngest dedup'es per id within its window,
 * so a ticker retry that re-emits the same row produces a no-op.
 *
 * `gitSha` is the deploy pinned at lock time. The fire handler does not
 * enforce it against the current row's `git_sha` — `runner.invoke` reads
 * whatever sha `main` points at, which is the same semantics as a manual
 * agent invocation. A rollback between tick and fire is observable in the
 * `skill_runs` row (different sha than the event payload).
 *
 * Skills don't carry a `catchup_missed` policy: schedule cron skills always
 * skip-ahead to the first occurrence after `now()` after a missed fire. The
 * agent-scheduled prompts pathway has the catchup knob because the user
 * sees the lateness; skills don't have an equivalent UX surface.
 */
export const skillCronFire = eventType("skills/cron.fire", {
  schema: z.object({
    skillId: z.string(),
    skillName: z.string(),
    gitSha: z.string(),
    scheduledFor: z.string(), // ISO 8601 UTC
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
