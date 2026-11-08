/**
 * `skill-runs-sweeper`: every 5 minutes, finish the skill runs stuck in
 * flight (design/skills.md → Run failures → Stuck runs). A run `started` 15
 * minutes ago and never dispatched finishes `host_lost`; one `dispatched`
 * past its `deadline_at` finishes `result_lost`, since its body may have
 * acted. Each move is a conditional UPDATE on the row's recovery point, so a
 * run whose own transition commits first is left alone, and the late
 * transition that loses to a sweep returns `swept`. Nothing is re-fired.
 */

import type { Inngest } from "inngest";
import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { fromStepTools } from "../inngest/durable.js";
import { logger } from "../logger.js";
import type { SkillStore, StuckRun, StuckRunCutoffs } from "./store/index.js";

const log = logger.child({ component: "skills.runs-sweeper" });

/**
 * How long a run may sit at `started`: past the 60 s worker init and the
 * populate's 180 s (whose own class allows 10 min), and a bound on the
 * pool's queue, which nothing else bounds beyond `max`.
 */
const STARTED_BOUND_MS = 15 * 60 * 1000;

/** Runs finished per tick; the next tick takes the rest. */
const SWEEP_BATCH_SIZE = 100;

export interface SkillRunsSweeperDeps {
  runInTx: Transactor;
  store: Pick<SkillStore, "listStuckRuns" | "sweepRun">;
}

/** The runs one sweep finished, by the kind each finished as. */
export interface SweepSummary {
  hostLost: string[];
  resultLost: string[];
}

export function createSkillRunsSweeper(deps: SkillRunsSweeperDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "skill-runs-sweeper",
      // A failed sweep leaves every row as it was; the next tick, 5 min
      // later, repeats it.
      retries: 0,
      concurrency: { limit: 1 },
      triggers: [{ cron: "*/5 * * * *" }],
    },
    async ({ step }) =>
      // One step: the body re-runs at most once, for its memoized result.
      fromStepTools(step).run("sweep", () => sweepStuckRuns(deps, { now: new Date() })),
  );
}

/**
 * Finish every run stuck as of `now`, each in its own transaction, and
 * return what finished. A run that moved on since the listing is skipped.
 */
export async function sweepStuckRuns(
  deps: SkillRunsSweeperDeps,
  args: { now: Date },
): Promise<SweepSummary> {
  const { now } = args;
  const cutoffs: StuckRunCutoffs = {
    createdBefore: new Date(now.getTime() - STARTED_BOUND_MS),
    deadlineBefore: now,
  };
  const stuck = await deps.runInTx((tx) =>
    deps.store.listStuckRuns(tx, { cutoffs, limit: SWEEP_BATCH_SIZE }),
  );
  const summary: SweepSummary = { hostLost: [], resultLost: [] };
  for (const run of stuck) {
    const transition = await deps.runInTx((tx) =>
      deps.store.sweepRun(tx, {
        run,
        cutoffs,
        message: sweptMessage(run),
        resourceUsage: {
          wallClockMs: Math.max(0, now.getTime() - run.createdAt.getTime()),
          peakMemoryBytes: null,
        },
        finishedAt: now,
      }),
    );
    match(transition)
      .with({ kind: "moved_on" }, () => undefined)
      .with({ kind: "swept" }, () => {
        sweptList(summary, run).push(run.id);
        log.warn({ runId: run.id, stuckAt: run.stuckAt }, "swept a skill run stuck in flight");
      })
      .exhaustive();
  }
  return summary;
}

function sweptList(summary: SweepSummary, run: StuckRun): string[] {
  return match(run.stuckAt)
    .with("started", () => summary.hostLost)
    .with("dispatched", () => summary.resultLost)
    .exhaustive();
}

function sweptMessage(run: StuckRun): string {
  return match(run.stuckAt)
    .with(
      "started",
      () =>
        `swept: no runtime dispatched the run within ${STARTED_BOUND_MS / 60_000} min of its start`,
    )
    .with(
      "dispatched",
      () =>
        "swept: the run was dispatched but reported no result by its deadline; the skill may have acted",
    )
    .exhaustive();
}
