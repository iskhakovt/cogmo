/**
 * Skill cron ticker. Static 1-min Inngest cron that:
 *
 *   1. Locks every non-disabled `skills` row whose `schedule IS NOT NULL`
 *      and `next_run_at <= now()` via `FOR UPDATE SKIP LOCKED`. Concurrent
 *      ticker retries don't double-pick the same row.
 *   2. For each row: stamps `last_fired_at` to the row's stale fire time
 *      and advances `next_run_at` to the first occurrence after `now()` in
 *      the configured timezone, all inside the same transaction.
 *   3. Returns the per-row event payloads from `step.run` so the downstream
 *      `step.sendEvent` replay is cached.
 *   4. Fan-outs `skills/cron.fire` events. Each event carries
 *      `id = ${skillId}:${scheduledFor}` so Inngest dedup'es duplicate emits
 *      across retries.
 *
 * Skills don't have a `catchup_missed` policy — a row whose `next_run_at`
 * is multiple days in the past fires once with that stale timestamp and
 * the row's `next_run_at` then skips forward to the first occurrence after
 * `now()`. Operators can observe the latency via `last_fired_at` if needed;
 * the fire-handler doesn't surface lateness to any user-facing channel.
 *
 * Parallel to `src/agent/scheduling/ticker.ts` which serves the
 * `scheduled_tasks` table. Shared design: same FOR UPDATE SKIP LOCKED
 * pattern, same `retries: 0` + cron-as-recovery posture, same per-event
 * idempotency key shape. Separate tables and events because the dispatch
 * semantics differ (skills are host-scoped, `runner.invoke` instead of
 * synthetic-inbound rotation). See design/skills.md → Invocation.
 */

import type { Inngest } from "inngest";
import { computeNextRun } from "../agent/scheduling/cron.js";
import type { Transactor } from "../db/index.js";
import { skillCronFire } from "../inngest/events.js";
import type { StepRun } from "../inngest/index.js";
import { logger } from "../logger.js";
import type { SkillRow, SkillStore } from "./store/index.js";

const log = logger.child({ component: "skills.cron-ticker" });

/**
 * Hard cap on rows picked per tick. Personal-scale single-user usage is
 * dozens-not-hundreds; 100 bounds Inngest run-state size (32 MB step
 * result limit, 5000 events/batch limit on `step.sendEvent`). Matches the
 * `scheduled-task-ticker` cap by design — the two cron systems share a
 * load profile and we want one knob to tune.
 */
const TICK_BATCH_SIZE = 100;

export interface SkillCronTickerDeps {
  runInTx: Transactor;
  store: Pick<SkillStore, "lockDueScheduledSkills" | "advanceSkillSchedule">;
  /**
   * IANA timezone used to evaluate `manifest.schedule` cron expressions
   * when advancing `next_run_at`. Wired from `env.USER_TIMEZONE`.
   */
  userTimezone: string;
  /** Override for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Override for tests to inject a smaller batch size. */
  batchSize?: number;
}

/** Payload mirror of `skillCronFire.data` — shared with the test harness. */
interface FirePayload {
  skillId: string;
  skillName: string;
  gitSha: string;
  scheduledFor: string;
}

export function createSkillCronTicker(deps: SkillCronTickerDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "skill-cron-ticker",
      // Pure dispatch — a transient DB blip shouldn't burn the retry
      // budget; the next minute's tick re-locks any rows we missed. Same
      // posture as `scheduled-task-ticker`: cron IS the recovery mechanism.
      retries: 0,
      // Singleton: never run two ticker bodies concurrently. FOR UPDATE
      // SKIP LOCKED is defense in depth; the function-level cap keeps the
      // dashboard tidy.
      concurrency: { limit: 1 },
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) => {
      const events = await runSkillCronTick(deps, step.run);
      if (events.length === 0) return { picked: 0 };
      await step.sendEvent(
        "fan-out",
        events.map((e) => ({
          ...skillCronFire.create(e),
          id: `${e.skillId}:${e.scheduledFor}`,
        })),
      );
      log.info({ picked: events.length }, "ticker fan-out");
      return { picked: events.length };
    },
  );
}

/**
 * Pure tick body — exposed for unit testing without an Inngest harness.
 * Returns the event payloads the ticker would have emitted, in the order
 * they were locked.
 */
export async function runSkillCronTick(
  deps: SkillCronTickerDeps,
  stepRun: StepRun,
): Promise<FirePayload[]> {
  const now = (deps.now ?? (() => new Date()))();
  const batchSize = deps.batchSize ?? TICK_BATCH_SIZE;

  return await stepRun("lock-and-advance", () =>
    deps.runInTx(async (tx) => {
      const due = await deps.store.lockDueScheduledSkills(tx, { now, limit: batchSize });
      const events: FirePayload[] = [];
      for (const row of due) {
        events.push(buildFirePayload(row));
        await deps.store.advanceSkillSchedule(
          tx,
          row.id,
          computeAdvance(row, now, deps.userTimezone),
        );
      }
      return events;
    }),
  );
}

function buildFirePayload(row: SkillRow): FirePayload {
  if (row.nextRunAt === null) {
    // Unreachable under the partial index + CHECK constraint — defense
    // against future shape drift that bypasses the store layer.
    throw new Error(`skill ${row.id}: locked by ticker with next_run_at=null — invariant violated`);
  }
  return {
    skillId: row.id,
    skillName: row.name,
    gitSha: row.gitSha,
    // The scheduled-for ts is the row's ORIGINAL fire time, not now() —
    // operators reading skill_runs can see "this fire was 3 days late" by
    // comparing scheduledFor against the run's created_at.
    scheduledFor: row.nextRunAt.toISOString(),
  };
}

function computeAdvance(
  row: SkillRow,
  now: Date,
  userTimezone: string,
): { lastFiredAt: Date; nextRunAt: Date } {
  if (row.schedule === null || row.nextRunAt === null) {
    throw new Error(
      `skill ${row.id}: schedule/nextRunAt null on a locked row — invariant violated`,
    );
  }
  // Skip-ahead policy: advance to the first occurrence strictly after
  // now(). One fire per outage window, no backfill.
  const nextRunAt = computeNextRun(row.schedule, userTimezone, now);
  return { lastFiredAt: row.nextRunAt, nextRunAt };
}
