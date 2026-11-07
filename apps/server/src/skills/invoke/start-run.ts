import { match, P } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import type { ExecutedOutcome, NewRunParams, SkillRunRow, SkillStore } from "../store/index.js";
import {
  finishedVerdictOf,
  reconstructFinishedResult,
  runErrorOf,
  type SkillRunResult,
} from "./run-result.js";

/**
 * Where an invocation takes up its run row, from the row's
 * `recovery_point` (design/skills.md → At-most-once invocation).
 */
export type RunStart =
  /** A row this attempt inserted at `started`: execute, then finish. */
  | { kind: "execute"; runId: string; createdAt: Date }
  /** A recovered row at `executed`: execute already ran, so finish only. */
  | { kind: "finish"; runId: string; executed: ExecutedOutcome }
  /** A recovered row at `finished`: the result it settled on. */
  | { kind: "replay"; result: SkillRunResult }
  /** A recovered row at `started` or `dispatched`: another attempt's, crashed or still running. */
  | { kind: "inflight"; runId: string };

/** The outcome an `executed` or `finished` row holds. */
export function executedOutcomeOf(
  row: Pick<SkillRunRow, "id" | "output" | "error" | "errorKind">,
): ExecutedOutcome {
  const error = runErrorOf(row);
  return error === null ? { kind: "output", output: row.output } : { kind: "error", error };
}

/**
 * Insert the run row, or with an idempotency key recover the row a prior
 * attempt under it left. Without a key every call gets a fresh row and no
 * cross-attempt deduplication.
 */
export async function startRun(
  deps: { store: SkillStore; runInTx: Transactor },
  args: NewRunParams & { idempotencyKey?: string },
): Promise<RunStart> {
  const { idempotencyKey, ...run } = args;
  if (idempotencyKey === undefined) {
    const inserted = await deps.runInTx((tx) => deps.store.insertRun(tx, run));
    return { kind: "execute", runId: inserted.id, createdAt: inserted.createdAt };
  }

  const { kind, row } = await deps.runInTx((tx) =>
    deps.store.startOrRecoverRun(tx, { ...run, idempotencyKey }),
  );
  if (kind === "new") return { kind: "execute", runId: row.id, createdAt: row.createdAt };
  return match(row.recoveryPoint)
    .returnType<RunStart>()
    .with(P.union("started", "dispatched"), () => ({ kind: "inflight", runId: row.id }))
    .with("executed", () => ({
      kind: "finish",
      runId: row.id,
      executed: executedOutcomeOf(row),
    }))
    .with("finished", () => ({
      kind: "replay",
      result: reconstructFinishedResult(row.id, finishedVerdictOf(row)),
    }))
    .exhaustive();
}
