/**
 * `pending | extracted → same | failed`: count a failure against a turn's
 * phase, guarded on the status and attempt count the caller read, and give
 * the turn up at `MAX_TURN_ATTEMPTS` or on a failure every attempt would
 * repeat (design/observation.md → Slice 1a → Transitions, Slice 2a).
 */

import { match } from "ts-pattern";
import type { Transactor } from "../../../db/index.js";
import { logger } from "../../../logger.js";
import type { AgentStore, OpenStatus, TurnFailure } from "../../store/index.js";
import { isTerminalTurnFailure, MAX_TURN_ATTEMPTS } from "./failure.js";
import type { TurnSettled } from "./turn-outcome.js";

export interface RecordTurnAttemptDeps {
  runInTx: Transactor;
  store: Pick<AgentStore, "recordTurnAttempt">;
}

export async function recordTurnAttempt(
  deps: RecordTurnAttemptDeps,
  args: { observationId: string; from: OpenStatus; seen: number; failure: TurnFailure },
): Promise<TurnSettled> {
  const { failure } = args;
  const attempts = args.seen + 1;
  const gaveUp = isTerminalTurnFailure(failure) || attempts >= MAX_TURN_ATTEMPTS;
  logger.warn(
    { observationId: args.observationId, failure: failure.kind, attempts },
    gaveUp
      ? "observer: turn's observation failed for good"
      : "observer: turn's observation failed — a later fire retries it",
  );
  const moved = await deps.runInTx((tx) =>
    deps.store.recordTurnAttempt(tx, {
      id: args.observationId,
      from: args.from,
      seen: args.seen,
      failure,
      giveUp: gaveUp,
    }),
  );
  return match(moved)
    .returnType<TurnSettled>()
    .with({ kind: "transitioned" }, () =>
      gaveUp
        ? { kind: "failed", attempts, failure: failure.kind }
        : { kind: "retryLater", attempts, failure: failure.kind },
    )
    .with({ kind: "stale" }, ({ status }) => ({ kind: "taken", status }))
    .exhaustive();
}
