/**
 * Scheduling namespace on the per-turn `Service`. Surfaces the
 * `schedule_task` / `list_tasks` / `remove_task` agent tools, the
 * wizard's recurring-tasks step, and the `/schedules` channel command
 * (when implemented).
 *
 * Per-conversation scope: every method operates on the user + profile
 * the orchestrator scopes the service to. Tools never pass userId or
 * profileId — those are baked in at factory time, mirroring the rest
 * of the Service ACL pattern.
 *
 * Validation, cap enforcement, and timezone defaulting live here so
 * every caller (tools, wizard, /schedules) gets identical semantics
 * without having to re-do the work.
 *
 * Error envelope: `Result<T, SchedulingError>`. The `kind` discriminator
 * carries enough detail for the LLM to self-correct from a `tool_result`
 * (e.g. `validation/malformed`, `validation/interval_too_short` —
 * openclaw#9283 showed unstructured cron errors cause infinite
 * retry loops).
 */

import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { AgentStore, ScheduledTask, ScheduleKind } from "../store/index.js";
import { type CronValidationError, computeNextRun, validateCron } from "./cron.js";

const log = logger.child({ component: "scheduling.service" });

/** Default per-user active-task cap. Higher than ChatGPT Tasks's 10 — single-user scale. */
export const DEFAULT_SCHEDULED_TASK_CAP = 200;

/**
 * Structured failure modes from the scheduling service. Each kind
 * carries the specific detail the LLM needs to fix its input. Mirrors
 * the `CronValidationError` shape from `cron.ts` for the validation
 * variants.
 */
export type SchedulingError =
  | { kind: "validation"; cause: CronValidationError }
  | { kind: "invalid_run_at"; runAt: string; message: string }
  | { kind: "task_cap_exceeded"; limit: number; current: number }
  | { kind: "not_found"; id: string };

/** Input for `service.scheduling.create` — discriminated by recurrence kind. */
export type CreateScheduleArgs =
  | {
      kind: "recurring";
      cron: string;
      /** IANA timezone, e.g. "Europe/London". Defaults to the service's `defaultTimezone`. */
      timezone?: string;
      prompt: string;
      /** If true, the ticker advances one occurrence per fire (drains backlog). Default false. */
      catchupMissed?: boolean;
    }
  | {
      kind: "one_off";
      /** ISO 8601 timestamp, e.g. "2026-06-01T15:00:00Z" or with offset "...+01:00". */
      runAt: string;
      /** Tz for audit display only — one-offs don't recur, so DST is irrelevant. Defaults to `defaultTimezone`. */
      timezone?: string;
      prompt: string;
    };

/** LLM-facing summary of a scheduled task, returned by `list`. */
export interface ScheduledTaskSummary {
  id: string;
  kind: ScheduleKind;
  cron: string | null;
  prompt: string;
  timezone: string;
  nextRunAt: Date;
  lastRunAt: Date | null;
  enabled: boolean;
}

export interface SchedulingService {
  /**
   * Create a scheduled task. Validates the cron (for recurring) or
   * `runAt` (for one-off), enforces the per-user cap, computes
   * `nextRunAt`, and persists. Returns `{ id, nextRunAt }` on success.
   */
  create(
    args: CreateScheduleArgs,
  ): Promise<Result<{ id: string; nextRunAt: Date }, SchedulingError>>;

  /** List all scheduled tasks for the scoped user, newest-first. Includes disabled rows. */
  list(): Promise<ReadonlyArray<ScheduledTaskSummary>>;

  /**
   * Delete a scheduled task. Verifies the row belongs to the scoped
   * user before deleting (defence against tools that supply a spoofed
   * id from another user). Returns `not_found` if the id doesn't
   * exist OR isn't owned by this user.
   */
  remove(id: string): Promise<Result<void, SchedulingError>>;
}

export interface SchedulingServiceDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  userId: string;
  profileId: string;
  /** Fallback IANA tz when create() args omit `timezone`. Sourced from `env.USER_TIMEZONE`. */
  defaultTimezone: string;
  /** Maximum active (enabled or disabled) tasks per user. Defaults to `DEFAULT_SCHEDULED_TASK_CAP`. */
  taskCap?: number;
}

export function createSchedulingService(deps: SchedulingServiceDeps): SchedulingService {
  const taskCap = deps.taskCap ?? DEFAULT_SCHEDULED_TASK_CAP;

  return {
    async create(args) {
      const timezone = args.timezone ?? deps.defaultTimezone;

      let nextRunAt: Date;
      let cron: string | null;
      const kind: ScheduleKind = args.kind;

      if (args.kind === "recurring") {
        const validation = validateCron(args.cron, timezone);
        if (validation.isErr()) {
          return err({ kind: "validation" as const, cause: validation.error });
        }
        cron = args.cron;
        // Anchor from `now()` — the first fire is the next cron
        // occurrence after the create call lands.
        nextRunAt = computeNextRun(args.cron, timezone, new Date());
      } else {
        const parsed = parseRunAt(args.runAt);
        if (parsed.isErr()) {
          return err(parsed.error);
        }
        cron = null;
        nextRunAt = parsed.value;
      }

      // Cap check + insert in the same tx so two concurrent creates
      // can't both squeak past the limit. Count includes disabled
      // rows so a user can't accumulate a graveyard of disabled
      // tasks and bypass the cap by toggling. Uses `countScheduledTasks`
      // (one SELECT COUNT(*)) rather than `listScheduledTasks` so we
      // don't pull every row's columns just to read `.length`.
      const result = await deps.runInTx(async (tx) => {
        const current = await deps.agentStore.countScheduledTasks(tx, deps.userId);
        if (current >= taskCap) {
          return err({
            kind: "task_cap_exceeded" as const,
            limit: taskCap,
            current,
          });
        }
        const row = await deps.agentStore.createScheduledTask(tx, {
          userId: deps.userId,
          profileId: deps.profileId,
          kind,
          cron,
          timezone,
          prompt: args.prompt,
          nextRunAt,
          enabled: true,
          catchupMissed: args.kind === "recurring" ? (args.catchupMissed ?? false) : false,
          source: "agent",
        });
        return ok({ id: row.id, nextRunAt: row.nextRunAt });
      });

      if (result.isOk()) {
        log.info(
          { taskId: result.value.id, userId: deps.userId, kind, nextRunAt: result.value.nextRunAt },
          "scheduled task created",
        );
      }
      return result;
    },

    async list() {
      const rows = await deps.runInTx((tx) => deps.agentStore.listScheduledTasks(tx, deps.userId));
      return rows.map(toSummary);
    },

    async remove(id) {
      // Two-step (get + delete) inside one tx so the ownership check
      // and the delete are atomic — no race window where another
      // request flips ownership between read and write at single-user
      // scale (not a real threat, but the right shape if we ever go
      // multi-user).
      return await deps.runInTx(async (tx) => {
        const row = await deps.agentStore.getScheduledTask(tx, id);
        if (!row || row.userId !== deps.userId) {
          return err({ kind: "not_found" as const, id });
        }
        await deps.agentStore.deleteScheduledTask(tx, id);
        log.info({ taskId: id, userId: deps.userId }, "scheduled task removed");
        return ok(undefined);
      });
    },
  };
}

function toSummary(row: ScheduledTask): ScheduledTaskSummary {
  return {
    id: row.id,
    kind: row.kind,
    cron: row.cron,
    prompt: row.prompt,
    timezone: row.timezone,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    enabled: row.enabled,
  };
}

function parseRunAt(runAt: string): Result<Date, SchedulingError> {
  // Reject ambiguity: ISO strings without an explicit tz marker (`Z`
  // or `±HH:MM`) are interpreted by `new Date()` in the host's
  // timezone, which is the server's tz — surprising for an LLM that
  // thought it was passing UTC. Require the tz to be explicit in the
  // string itself (consistent with `Temporal.Instant.from` semantics
  // adopted by the JS standards process).
  const hasTzMarker = /Z$|[+-]\d{2}:?\d{2}$/i.test(runAt);
  if (!hasTzMarker) {
    return err({
      kind: "invalid_run_at" as const,
      runAt,
      message:
        "runAt must be an ISO 8601 timestamp with an explicit timezone marker " +
        "(e.g. '2026-06-01T15:00:00Z' or '2026-06-01T15:00:00+01:00')",
    });
  }
  const date = new Date(runAt);
  if (Number.isNaN(date.getTime())) {
    return err({
      kind: "invalid_run_at" as const,
      runAt,
      message: "runAt is not a parseable ISO 8601 timestamp",
    });
  }
  if (date.getTime() <= Date.now()) {
    return err({
      kind: "invalid_run_at" as const,
      runAt,
      message: "runAt must be in the future",
    });
  }
  return ok(date);
}
