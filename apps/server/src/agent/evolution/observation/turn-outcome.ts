import type { ObservationFailureKindValue, ObservationStatusValue } from "../../store/schema.js";
import type { ExtractionResult } from "../extract-corrections.js";

/** What a turn's step did in either phase, short of applying or holding it. */
export type TurnSettled =
  | { kind: "skipped"; reason: "empty" }
  /** The row had left the plan's statuses before the step began: a re-run, or another run's work. */
  | { kind: "done"; status: ObservationStatusValue }
  /** This step's guarded write lost to another run that moved the row first. */
  | { kind: "taken"; status: ObservationStatusValue }
  | { kind: "retryLater"; attempts: number; failure: ObservationFailureKindValue }
  | { kind: "failed"; attempts: number; failure: ObservationFailureKindValue };

/** What one turn's corrections step did; small and JSON-safe, so a replay returns it as it is. */
export type TurnOutcome =
  | { kind: "applied"; result: ExtractionResult; droppedNoEvidence: number }
  | TurnSettled;

/** What one turn's memories step did. */
export type MemoryTurnOutcome =
  | {
      kind: "applied";
      /** Facts retained, by network. */
      byNetwork: Record<string, number>;
      droppedNoEvidence: number;
    }
  /** A user's memory rule binds a profile that can't see it: `held` or `held_extracted`. */
  | { kind: "held" }
  | TurnSettled;
