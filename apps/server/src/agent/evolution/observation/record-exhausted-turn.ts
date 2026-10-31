/**
 * Count a turn's step that failed after its retries with a failure the turn
 * may not have caused (an outage, an expired key, a database error). It is
 * an attempt like any other, so a turn that keeps throwing is given up at
 * `MAX_TURN_ATTEMPTS` fires instead of holding its conversation's later
 * turns for good (design/observation.md → Slice 1a, Failure modes row e).
 */

import type { Transactor } from "../../../db/index.js";
import type { AgentStore } from "../../store/index.js";
import { recordTurnAttempt } from "./record-turn-attempt.js";
import type { TurnOutcome } from "./turn-outcome.js";

export interface RecordExhaustedTurnDeps {
  runInTx: Transactor;
  store: Pick<AgentStore, "getTurnObservation" | "recordTurnAttempt">;
}

export async function recordExhaustedTurn(
  deps: RecordExhaustedTurnDeps,
  args: { observationId: string; message: string },
): Promise<TurnOutcome> {
  const row = await deps.runInTx((tx) => deps.store.getTurnObservation(tx, args.observationId));
  // The id came from this run's plan, and no code deletes the rows.
  if (row === undefined) throw new Error(`turn observation ${args.observationId} is missing`);
  if (row.status !== "pending") return { kind: "done", status: row.status };
  return recordTurnAttempt(deps, {
    observationId: args.observationId,
    seen: row.attempts,
    failure: { kind: "exhausted", message: args.message },
  });
}
