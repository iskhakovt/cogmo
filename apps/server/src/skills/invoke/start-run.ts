import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import type { SkillRunRow, SkillRunTrigger, SkillStore } from "../store/index.js";
import { reconstructFinishedResult, type SkillRunResult } from "./run-result.js";

/** What an executed run produced, as its `executed` row records it. */
export type ExecutedOutcome =
  | { kind: "output"; output: unknown | null }
  | { kind: "error"; error: string };

/**
 * Where an invocation takes up its run row, from the row's
 * `recovery_point` (design/skills.md → Exactly-once invocation).
 */
export type RunStart =
  /** A row this attempt inserted at `started`: execute, then finish. */
  | { kind: "execute"; runId: string; createdAt: Date }
  /** A recovered row at `executed`: execute already ran, so finish only. */
  | { kind: "finish"; runId: string; executed: ExecutedOutcome }
  /** A recovered row at `finished`: the result it settled on. */
  | { kind: "replay"; result: SkillRunResult }
  /** A recovered row at `started`: another attempt's, crashed or still running. */
  | { kind: "inflight"; runId: string };

/** The outcome an `executed` or `finished` row holds. */
export function executedOutcomeOf(row: Pick<SkillRunRow, "output" | "error">): ExecutedOutcome {
  return row.error !== null
    ? { kind: "error", error: row.error }
    : { kind: "output", output: row.output };
}

/**
 * Insert the run row, or with an idempotency key recover the row a prior
 * attempt under it left. Without a key every call gets a fresh row and no
 * cross-attempt deduplication.
 */
export async function startRun(
  deps: { store: SkillStore; runInTx: Transactor },
  args: { skillId: string; trigger: SkillRunTrigger; inputs: unknown; idempotencyKey?: string },
): Promise<RunStart> {
  const { idempotencyKey } = args;
  if (idempotencyKey === undefined) {
    const run = await deps.runInTx((tx) =>
      deps.store.insertRun(tx, {
        skillId: args.skillId,
        trigger: args.trigger,
        inputs: args.inputs,
      }),
    );
    return { kind: "execute", runId: run.id, createdAt: run.createdAt };
  }

  const { kind, row } = await deps.runInTx((tx) =>
    deps.store.startOrRecoverRun(tx, {
      skillId: args.skillId,
      trigger: args.trigger,
      inputs: args.inputs,
      idempotencyKey,
    }),
  );
  if (kind === "new") return { kind: "execute", runId: row.id, createdAt: row.createdAt };
  return match(row.recoveryPoint)
    .returnType<RunStart>()
    .with("started", () => ({ kind: "inflight", runId: row.id }))
    .with("executed", () => ({
      kind: "finish",
      runId: row.id,
      executed: executedOutcomeOf(row),
    }))
    .with("finished", () => ({
      kind: "replay",
      result: reconstructFinishedResult(row.id, row.status, row.output, row.error),
    }))
    .exhaustive();
}
