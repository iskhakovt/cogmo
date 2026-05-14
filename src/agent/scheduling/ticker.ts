/**
 * Scheduled-task ticker. Static 1-min Inngest cron that:
 *
 *   1. Locks every enabled `scheduled_tasks` row whose `next_run_at <= now()`
 *      via `FOR UPDATE SKIP LOCKED`. Concurrent ticker retries don't
 *      double-pick the same row.
 *   2. For each row: computes the next occurrence in the user's tz (or
 *      flips `enabled=false` for one-offs) and writes both back inside
 *      the same transaction.
 *   3. Returns the per-row event payloads from the step.run, which
 *      Inngest persists into run state — so a downstream sendEvent
 *      replay is replay-safe.
 *   4. Fan-outs the events via `step.sendEvent`. Each event carries
 *      `id = ${taskId}:${scheduledFor}` so Inngest dedup'es duplicate
 *      emits across retries.
 *
 * Catch-up semantics:
 *   - `catchup_missed = false` (default): on missed ticks, fire once
 *     with the row's stale `next_run_at` and then skip the row's
 *     `next_run_at` forward to the first occurrence after `now()`. One
 *     fire per outage window. The fire handler reads `scheduledFor`
 *     from the event so the model can be self-aware about lateness.
 *   - `catchup_missed = true`: advance one occurrence per tick. A 3-day
 *     outage on a daily cron drains over 3 minutes (3 fires). Correct
 *     but possibly noisy — the column is opt-in for that reason.
 *
 * One-off rows (`kind = 'one_off'`) fire once, then `enabled` flips to
 * `false`; `next_run_at` is left untouched (no recurrence to advance
 * to). Future re-enabling would re-fire — that's intentional, since
 * `remove_task` is the path for "never fire again."
 *
 * See design/scheduling.md → Agent Self-Scheduling.
 */

import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { scheduledTaskFire } from "../../inngest/events.js";
import type { StepRun } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import type { AgentStore, ScheduledTask } from "../store/index.js";
import { computeNextRun } from "./cron.js";

const log = logger.child({ component: "scheduling.ticker" });

/**
 * Hard cap on rows picked per tick. Personal-scale single-user usage is
 * dozens-not-hundreds, so 100 is generous; the cap exists to bound
 * payload size into Inngest's run state (32 MB step result limit, 5000
 * events/batch limit on `step.sendEvent`).
 */
const TICK_BATCH_SIZE = 100;

export interface SchedulingTickerDeps {
  runInTx: Transactor;
  store: Pick<AgentStore, "lockDueScheduledTasks" | "advanceScheduledTask">;
  /** Override for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Override for tests to inject a smaller batch size. */
  batchSize?: number;
}

/** Payload mirror of `scheduledTaskFire.data` — shared with the test harness. */
interface FirePayload {
  taskId: string;
  userId: string;
  profileId: string;
  scheduledFor: string;
  prompt: string;
}

export function createScheduledTaskTicker(deps: SchedulingTickerDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "scheduled-task-ticker",
      // The ticker is pure dispatch — a transient DB blip shouldn't burn
      // its retry budget; the next minute's tick re-locks any rows we
      // missed (their `next_run_at` is still in the past). Note that
      // `retries: 0` at the function level also disables step-level
      // retries — a `step.run("lock-and-advance")` failure aborts the
      // whole invocation rather than retrying the step. That's the
      // intended trade-off: cron is the recovery mechanism, not
      // mid-invocation backoff. If you bump this to `retries: 1`
      // expecting step-level resilience, you'd also get function-level
      // re-invocation, which would re-lock rows whose `next_run_at`
      // already advanced past `now()` between attempts. Stay at 0.
      retries: 0,
      // Singleton: never run two ticker bodies concurrently. The
      // FOR UPDATE SKIP LOCKED is defense in depth, but limiting at the
      // function level keeps the dashboard tidy and prevents pathological
      // overlap if Inngest ever fires a tick early.
      concurrency: { limit: 1 },
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) => {
      const events = await runScheduledTaskTick(deps, step.run);
      if (events.length === 0) return { picked: 0 };
      // `step.sendEvent` is itself a durable step — a ticker retry won't
      // re-emit because the per-event idempotency keys (set on `.id`
      // below) dedup at Inngest's event bus.
      await step.sendEvent(
        "fan-out",
        events.map((e) => ({
          ...scheduledTaskFire.create(e),
          id: `${e.taskId}:${e.scheduledFor}`,
        })),
      );
      log.info({ picked: events.length }, "ticker fan-out");
      return { picked: events.length };
    },
  );
}

/**
 * Pure tick body — exposed for unit testing without an Inngest harness.
 * Returns the event payloads the ticker would have emitted, in the
 * order they were locked.
 */
export async function runScheduledTaskTick(
  deps: SchedulingTickerDeps,
  stepRun: StepRun,
): Promise<FirePayload[]> {
  const now = (deps.now ?? (() => new Date()))();
  const batchSize = deps.batchSize ?? TICK_BATCH_SIZE;

  // One step.run wraps lock + advance + payload construction. Inngest
  // persists the return value, so a step retry replays from cache
  // (idempotent — no double-locking, no double-advance).
  return await stepRun("lock-and-advance", () =>
    deps.runInTx(async (tx) => {
      const due = await deps.store.lockDueScheduledTasks(tx, { now, limit: batchSize });
      const events: FirePayload[] = [];
      for (const row of due) {
        events.push(buildFirePayload(row));
        await deps.store.advanceScheduledTask(tx, row.id, computeAdvance(row, now));
      }
      return events;
    }),
  );
}

function buildFirePayload(row: ScheduledTask): FirePayload {
  return {
    taskId: row.id,
    userId: row.userId,
    profileId: row.profileId,
    // The scheduled-for ts is the row's *original* fire time, not `now()` —
    // so the fire handler can render "this was meant for 09:00, it's now
    // 10:30" when the ticker is late after an outage.
    scheduledFor: row.nextRunAt.toISOString(),
    prompt: row.prompt,
  };
}

function computeAdvance(
  row: ScheduledTask,
  now: Date,
): { lastRunAt: Date; nextRunAt: Date; disable?: boolean } {
  // One-off: never advance, just disable. `next_run_at` stays at the
  // fired timestamp (audit-friendly — we can see when it actually ran).
  if (row.kind === "one_off") {
    return { lastRunAt: row.nextRunAt, nextRunAt: row.nextRunAt, disable: true };
  }
  // Recurring: cron is non-null (DB CHECK enforces). Compute next
  // occurrence based on catchup policy.
  if (!row.cron) {
    // Should be unreachable given the CHECK, but defend against future
    // shape drift by throwing loudly instead of silently advancing to
    // `row.nextRunAt`.
    throw new Error(
      `scheduled_task ${row.id}: kind='recurring' but cron is null — CHECK constraint should have rejected this row`,
    );
  }
  const anchor = row.catchupMissed ? row.nextRunAt : now;
  const nextRunAt = computeNextRun(row.cron, row.timezone, anchor);
  return { lastRunAt: row.nextRunAt, nextRunAt };
}
