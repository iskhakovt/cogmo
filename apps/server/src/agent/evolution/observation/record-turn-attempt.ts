/**
 * `pending → pending | failed`: count a failure against a turn, guarded on
 * the attempt count the caller read, and give the turn up at
 * `MAX_TURN_ATTEMPTS` or on a failure every attempt would repeat
 * (design/observation.md → Slice 1a → Transitions).
 */

import { match } from "ts-pattern";
import type { Transactor } from "../../../db/index.js";
import { logger } from "../../../logger.js";
import type { AgentStore, TurnFailure } from "../../store/index.js";
import { isTerminalTurnFailure, MAX_TURN_ATTEMPTS } from "./failure.js";
import type { TurnOutcome } from "./turn-outcome.js";

export interface RecordTurnAttemptDeps {
  runInTx: Transactor;
  store: Pick<AgentStore, "recordTurnAttempt">;
}

export async function recordTurnAttempt(
  deps: RecordTurnAttemptDeps,
  args: { observationId: string; seen: number; failure: TurnFailure },
): Promise<TurnOutcome> {
  const { failure } = args;
  const attempts = args.seen + 1;
  const gaveUp = isTerminalTurnFailure(failure) || attempts >= MAX_TURN_ATTEMPTS;
  logger.warn(
    { observationId: args.observationId, failure: failure.kind, attempts },
    gaveUp
      ? "observer: turn's correction extraction failed for good"
      : "observer: turn's correction extraction failed — a later fire retries it",
  );
  const moved = await deps.runInTx((tx) =>
    deps.store.recordTurnAttempt(tx, {
      id: args.observationId,
      seen: args.seen,
      failure,
      to: gaveUp ? "failed" : "pending",
    }),
  );
  return match(moved)
    .returnType<TurnOutcome>()
    .with({ kind: "transitioned" }, () =>
      gaveUp
        ? { kind: "failed", attempts, failure: failure.kind }
        : { kind: "retryLater", attempts, failure: failure.kind },
    )
    .with({ kind: "stale" }, ({ status }) => ({ kind: "taken", status }))
    .exhaustive();
}
