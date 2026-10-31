import type { ObservationFailureKindValue, ObservationStatusValue } from "../../store/schema.js";
import type { ExtractionResult } from "../extract-corrections.js";

/** What one turn's step did; small and JSON-safe, so a replay returns it as it is. */
export type TurnOutcome =
  | { kind: "applied"; result: ExtractionResult; droppedNoEvidence: number }
  | { kind: "skipped"; reason: "empty" }
  /** The row had left `pending` before the step began: a re-run, or another run's work. */
  | { kind: "done"; status: ObservationStatusValue }
  /** This step's guarded write lost to another run that moved the row first. */
  | { kind: "taken"; status: ObservationStatusValue }
  | { kind: "retryLater"; attempts: number; failure: ObservationFailureKindValue }
  | { kind: "failed"; attempts: number; failure: ObservationFailureKindValue };
