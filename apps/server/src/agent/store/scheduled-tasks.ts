import { and, asc, count, desc, eq, getTableColumns, lte, sql } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { scheduledTasks } from "./schema.js";

/** Mirrors the `schedule_kind` PG enum. */
export type ScheduleKind = "recurring" | "one_off";

/** Mirrors the `schedule_source` PG enum. */
export type ScheduleSource = "agent" | "wizard" | "manual";

/**
 * A user/agent-defined scheduled task. `cron` is null for one-off rows
 * (the row fires once at `nextRunAt` and then flips `enabled = false`),
 * non-null for recurring rows (the ticker advances `nextRunAt` on every
 * fire). `timezone` anchors the cron expression so DST transitions don't
 * drift; `nextRunAt` itself is stored in UTC. See design/scheduling.md.
 */
export interface ScheduledTask {
  id: string;
  userId: string;
  profileId: string;
  kind: ScheduleKind;
  cron: string | null;
  timezone: string;
  prompt: string;
  nextRunAt: Date;
  lastRunAt: Date | null;
  enabled: boolean;
  catchupMissed: boolean;
  source: ScheduleSource;
  createdAt: Date;
}

/** The `scheduled_tasks` rows: prompts the ticker fires as a profile, once or on a cron. */
export interface ScheduledTaskStore {
  /**
   * Insert a scheduled task. Caller is responsible for cron / timezone
   * validation (done at the tool layer via `croner` + `Intl.DateTimeFormat`)
   * and for computing `nextRunAt` from the cron expression in the user's tz. The
   * DB CHECK pins the `kind ↔ cron` invariant: passing `cron: null` for a
   * `recurring` row (or non-null for `one_off`) raises a 23514 the caller
   * must translate. See design/scheduling.md.
   */
  createScheduledTask(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      kind: ScheduleKind;
      cron: string | null;
      timezone: string;
      prompt: string;
      nextRunAt: Date;
      enabled: boolean;
      catchupMissed: boolean;
      source: ScheduleSource;
    },
  ): Promise<ScheduledTask>;

  /**
   * Idempotent schedule creation. A second call carrying the same key returns
   * `kind: "recovered"` and the original row rather than scheduling a second
   * fire — the one duplicate on the durable-tool list that repeats forever.
   * Separate from {@link ScheduledTaskStore.createScheduledTask} because this one can
   * decline to insert. Mirrors `CodingStore.insertOrRecoverTask`.
   */
  createOrRecoverScheduledTask(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      kind: ScheduleKind;
      cron: string | null;
      timezone: string;
      prompt: string;
      nextRunAt: Date;
      enabled: boolean;
      catchupMissed: boolean;
      source: ScheduleSource;
      idempotencyKey: string;
    },
  ): Promise<{ kind: "new" | "recovered"; row: ScheduledTask }>;

  /** Load a single scheduled task by id. Returns undefined when not found. */
  getScheduledTask(tx: Transaction, id: string): Promise<ScheduledTask | undefined>;

  /**
   * Load a scheduled task by its idempotency key. Lets a caller recognise a
   * retry before spending a cap check on it — the row a retry is recovering
   * counts toward that cap.
   */
  getScheduledTaskByIdempotencyKey(
    tx: Transaction,
    key: string,
  ): Promise<ScheduledTask | undefined>;

  /**
   * List scheduled tasks for a user, newest-first. Used by `/schedules`
   * and `list_tasks`. `includeDisabled` defaults to `true` — `/schedules`
   * wants to show disabled rows; `list_tasks` callers that only want
   * "what's currently going to fire" pass `false`.
   */
  listScheduledTasks(
    tx: Transaction,
    userId: string,
    opts?: { includeDisabled?: boolean },
  ): Promise<ReadonlyArray<ScheduledTask>>;

  /**
   * Count scheduled tasks for a user. Faster than `listScheduledTasks`
   * when the caller only needs the total (e.g. the per-user cap check
   * in `SchedulingService.create`). Counts BOTH enabled and disabled
   * rows so a graveyard of disabled tasks can't bypass the cap by
   * toggling — same scope as `listScheduledTasks` default.
   */
  countScheduledTasks(tx: Transaction, userId: string): Promise<number>;

  /**
   * Lock and return up to `limit` rows whose `next_run_at <= now` and that
   * are enabled, in `next_run_at` order. Uses `FOR UPDATE SKIP LOCKED` so
   * concurrent ticker runs (e.g. a retried Inngest step) don't double-pick
   * the same row. Caller MUST advance every returned row in the same
   * transaction via `advanceScheduledTask` before commit, otherwise the
   * row will re-fire on the next tick.
   *
   * Replay-safety note: this method does NOT need to be deterministic
   * across invocations — its return value is captured inside the
   * ticker's `step.run("lock-and-advance", ...)`, and Inngest replays
   * the cached step result on retry rather than re-invoking the body.
   * `now` is just the timestamp the caller snapshots once (outside
   * `step.run`) and passes in so the SQL predicate is explicit, not a
   * determinism mechanism.
   */
  lockDueScheduledTasks(
    tx: Transaction,
    params: { now: Date; limit: number },
  ): Promise<ReadonlyArray<ScheduledTask>>;

  /**
   * Advance a row after the ticker has picked it: stamp `last_run_at` to
   * the timestamp that was just fired, set `next_run_at` to the next
   * occurrence (or leave unchanged for one-offs — the row's `enabled` flips
   * to false instead). Caller computes `nextRunAt` from `croner` for
   * recurring rows and passes `disable: true` for one-offs so the same
   * row isn't picked again on the next tick.
   */
  advanceScheduledTask(
    tx: Transaction,
    id: string,
    params: { lastRunAt: Date; nextRunAt: Date; disable?: boolean },
  ): Promise<void>;

  /**
   * Flip `enabled` for a scheduled task. Used by `/disable` /` /enable`
   * channel commands and by `remove_task` (which deletes outright instead).
   * No-ops if the row doesn't exist — caller checks existence via
   * `getScheduledTask` when it needs to distinguish "disabled" from
   * "didn't exist".
   */
  setScheduledTaskEnabled(tx: Transaction, id: string, enabled: boolean): Promise<void>;

  /** Delete a scheduled task by id. No-ops if the row doesn't exist. */
  deleteScheduledTask(tx: Transaction, id: string): Promise<void>;
}

/** Column values shared by both scheduled-task insert paths. */
function scheduleValues(params: {
  userId: string;
  profileId: string;
  kind: ScheduleKind;
  cron: string | null;
  timezone: string;
  prompt: string;
  nextRunAt: Date;
  enabled: boolean;
  catchupMissed: boolean;
  source: ScheduleSource;
}) {
  return {
    userId: params.userId,
    profileId: params.profileId,
    kind: params.kind,
    cron: params.cron,
    timezone: params.timezone,
    prompt: params.prompt,
    nextRunAt: params.nextRunAt,
    enabled: params.enabled,
    catchupMissed: params.catchupMissed,
    source: params.source,
  };
}

function rowToScheduledTask(row: typeof scheduledTasks.$inferSelect): ScheduledTask {
  return {
    id: row.id,
    userId: row.userId,
    profileId: row.profileId,
    kind: row.kind,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    enabled: row.enabled,
    catchupMissed: row.catchupMissed,
    source: row.source,
    createdAt: row.createdAt,
  };
}

export class DrizzleScheduledTaskStore implements ScheduledTaskStore {
  async createScheduledTask(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      kind: ScheduleKind;
      cron: string | null;
      timezone: string;
      prompt: string;
      nextRunAt: Date;
      enabled: boolean;
      catchupMissed: boolean;
      source: ScheduleSource;
    },
  ): Promise<ScheduledTask> {
    return rowToScheduledTask(
      single(await tx.insert(scheduledTasks).values(scheduleValues(params)).returning()),
    );
  }

  async createOrRecoverScheduledTask(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      kind: ScheduleKind;
      cron: string | null;
      timezone: string;
      prompt: string;
      nextRunAt: Date;
      enabled: boolean;
      catchupMissed: boolean;
      source: ScheduleSource;
      idempotencyKey: string;
    },
  ): Promise<{ kind: "new" | "recovered"; row: ScheduledTask }> {
    const key = params.idempotencyKey;
    // Keyed insert: see `.claude/rules/inngest.md`.
    //
    // `xmax = 0` distinguishes the outcomes, so the caller can recover a retry
    // inside the same transaction as its cap check rather than pre-reading in
    // one of its own.
    const rows = await tx
      .insert(scheduledTasks)
      .values({ ...scheduleValues(params), idempotencyKey: key })
      .onConflictDoUpdate({
        target: scheduledTasks.idempotencyKey,
        set: { idempotencyKey: key },
      })
      .returning({ ...getTableColumns(scheduledTasks), inserted: sql<boolean>`(xmax = 0)` });
    const { inserted, ...row } = single(rows);
    return { kind: inserted ? "new" : "recovered", row: rowToScheduledTask(row) };
  }

  async getScheduledTaskByIdempotencyKey(
    tx: Transaction,
    key: string,
  ): Promise<ScheduledTask | undefined> {
    const rows = await tx
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.idempotencyKey, key))
      .limit(1);
    const row = rows[0];
    return row ? rowToScheduledTask(row) : undefined;
  }

  async getScheduledTask(tx: Transaction, id: string): Promise<ScheduledTask | undefined> {
    const rows = await tx.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).limit(1);
    const row = rows[0];
    return row ? rowToScheduledTask(row) : undefined;
  }

  async listScheduledTasks(
    tx: Transaction,
    userId: string,
    opts?: { includeDisabled?: boolean },
  ): Promise<ReadonlyArray<ScheduledTask>> {
    const includeDisabled = opts?.includeDisabled ?? true;
    const where = includeDisabled
      ? eq(scheduledTasks.userId, userId)
      : and(eq(scheduledTasks.userId, userId), eq(scheduledTasks.enabled, true));
    const rows = await tx
      .select()
      .from(scheduledTasks)
      .where(where)
      .orderBy(desc(scheduledTasks.createdAt));
    return rows.map(rowToScheduledTask);
  }

  async countScheduledTasks(tx: Transaction, userId: string): Promise<number> {
    const rows = await tx
      .select({ value: count() })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.userId, userId));
    return rows[0]?.value ?? 0;
  }

  async lockDueScheduledTasks(
    tx: Transaction,
    params: { now: Date; limit: number },
  ): Promise<ReadonlyArray<ScheduledTask>> {
    const rows = await tx
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, params.now)))
      .orderBy(asc(scheduledTasks.nextRunAt))
      .limit(params.limit)
      .for("update", { skipLocked: true });
    return rows.map(rowToScheduledTask);
  }

  async advanceScheduledTask(
    tx: Transaction,
    id: string,
    params: { lastRunAt: Date; nextRunAt: Date; disable?: boolean },
  ): Promise<void> {
    const updates: {
      lastRunAt: Date;
      nextRunAt: Date;
      enabled?: boolean;
    } = {
      lastRunAt: params.lastRunAt,
      nextRunAt: params.nextRunAt,
    };
    if (params.disable) {
      updates.enabled = false;
    }
    await tx.update(scheduledTasks).set(updates).where(eq(scheduledTasks.id, id));
  }

  async setScheduledTaskEnabled(tx: Transaction, id: string, enabled: boolean): Promise<void> {
    await tx.update(scheduledTasks).set({ enabled }).where(eq(scheduledTasks.id, id));
  }

  async deleteScheduledTask(tx: Transaction, id: string): Promise<void> {
    await tx.delete(scheduledTasks).where(eq(scheduledTasks.id, id));
  }
}
