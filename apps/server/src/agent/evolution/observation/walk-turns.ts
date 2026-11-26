/**
 * One phase's walk through its planned turns (design/observation.md → Slice 1a
 * → One fire, Slice 2a → One fire): discovery and the plan in one step, then
 * one step per turn, oldest first, stopping at the first outcome that isn't a
 * clean move, so a later turn is never applied ahead of an earlier one that
 * can still succeed. A step that failed after its retries, discovery's or a
 * turn's, stops the phase and marks it failed; the turns before it keep their
 * outcomes, and the fire's later phases still run. Step ids come from the
 * memoized plan, so every replay plans the same steps.
 */

import { StepError } from "inngest";
import * as R from "remeda";
import { match } from "ts-pattern";
import { logger } from "../../../logger.js";
import type { OpenStatus, OpenTurn } from "../../store/index.js";
import type { ObservationPhaseValue } from "../../store/schema.js";
import { isUnavailable } from "./failure.js";
import { type RecordTurnAttemptDeps, recordTurnAttempt } from "./record-turn-attempt.js";
import type { MemoryTurnOutcome, TurnOutcome, TurnSettled } from "./turn-outcome.js";

/**
 * The minimal slice of Inngest's `step` API the Observer uses. Lets tests and
 * `/reflect` call the handler with `(name, fn) => fn()` while preserving the
 * production memoization shape.
 */
export interface ObserverStepHarness {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

type OutcomeKind = TurnOutcome["kind"] | MemoryTurnOutcome["kind"];

/**
 * A planned turn as a plan's memo holds it. A corrections plan memoized
 * before plans carried a status holds `pending` turns only.
 */
interface PlannedTurn extends Omit<OpenTurn, "status"> {
  status?: OpenStatus;
}

/** A plan a phase walks: its turns, and how many wait beyond them. */
export interface WalkablePlan {
  turns: ReadonlyArray<PlannedTurn>;
  remaining: number;
}

export interface WalkedPhase<P, O> {
  /** The memoized plan, or null when discovery failed for good. */
  plan: P | null;
  outcomes: ReadonlyArray<O | TurnSettled>;
  /** Whether a step failed after its retries. */
  failed: boolean;
  /** Turns still `pending` or `extracted` after the walk. */
  remaining: number;
}

export async function walkTurns<P extends WalkablePlan, O extends { kind: OutcomeKind }>(
  step: ObserverStepHarness,
  args: {
    conversationId: string;
    phase: ObservationPhaseValue;
    discoverStepId: string;
    discover: () => Promise<P>;
    observe: (turn: OpenTurn) => Promise<O>;
    deps: RecordTurnAttemptDeps;
  },
): Promise<WalkedPhase<P, O>> {
  const { conversationId, phase } = args;
  const outcomes: Array<O | TurnSettled> = [];
  const exhausted = (err: StepError) => {
    logger.warn(
      { err, conversationId, phase, stepId: err.stepId },
      "observer: phase failed after retries — continuing without the rest of it",
    );
  };
  let plan: P | null = null;
  let failed = false;
  try {
    plan = await step.run(args.discoverStepId, args.discover);
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
    exhausted(err);
    failed = true;
  }
  for (const planned of plan?.turns ?? []) {
    const turn: OpenTurn = { ...planned, status: planned.status ?? "pending" };
    const observationId = turn.observationId;
    let outcome: O;
    try {
      outcome = await step.run(`observe-v1-${phase}-${observationId}`, () => args.observe(turn));
    } catch (err) {
      if (!(err instanceof StepError)) throw err;
      exhausted(err);
      failed = true;
      // An unavailable call isn't the turn's: the turn stays as it is for a
      // later fire. Any other failure counts against it, so a turn that keeps
      // throwing is given up after `MAX_TURN_ATTEMPTS` fires. Planned only
      // after the memoized failure, so every replay plans it again; guarded on
      // the plan's status and count, so a re-run counts once and a row another
      // run moved since counts nothing.
      if (!isUnavailable(err)) {
        try {
          outcomes.push(
            await step.run(`observe-v1-${phase}-exhausted-${observationId}`, () =>
              recordTurnAttempt(args.deps, {
                observationId,
                from: turn.status,
                seen: turn.attempts,
                failure: { kind: "exhausted", message: err.message },
              }),
            ),
          );
        } catch (recordErr) {
          if (!(recordErr instanceof StepError)) throw recordErr;
          exhausted(recordErr);
        }
      }
      break;
    }
    outcomes.push(outcome);
    if (!continuesPhase(outcome.kind)) break;
  }
  const finished = R.sumBy(outcomes, (o) => (finishesTurn(o.kind) ? 1 : 0));
  return {
    plan,
    outcomes,
    failed,
    remaining: plan === null ? 0 : plan.remaining + plan.turns.length - finished,
  };
}

/** Whether the walk goes on to the next turn after this one's outcome. */
function continuesPhase(kind: OutcomeKind): boolean {
  return match(kind)
    .with("applied", "held", "skipped", "done", () => true)
    .with("taken", "retryLater", "failed", () => false)
    .exhaustive();
}

/** Whether the turn left the plan for good: everything but a retry or another run's move. */
function finishesTurn(kind: OutcomeKind): boolean {
  return match(kind)
    .with("applied", "held", "skipped", "done", "failed", () => true)
    .with("taken", "retryLater", () => false)
    .exhaustive();
}
