import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import { type SkillSourceCacheEntry, schemaIssues } from "../source-cache.js";
import type { ExecutedOutcome, SkillRunVerdict, SkillStore } from "../store/index.js";
import { finishedVerdictOf, reconstructFinishedResult, type SkillRunResult } from "./run-result.js";

/**
 * The `executed → finished` transition: validate the executed output against
 * the manifest's `outputs` schema and settle the run's terminal status.
 * Validation is pure, so a recovered `executed` row reaches the verdict the
 * original attempt would have. A concurrent attempt that finished the row
 * first wins: its settled result is returned.
 */
export async function finishRun(
  deps: { store: SkillStore; runInTx: Transactor },
  args: {
    runId: string;
    skillName: string;
    cached: SkillSourceCacheEntry;
    executed: ExecutedOutcome;
  },
): Promise<SkillRunResult> {
  const { runId } = args;
  const verdict = match(args.executed)
    .returnType<SkillRunVerdict>()
    .with({ kind: "error" }, ({ error }) => ({ status: "error", error }))
    .with({ kind: "output" }, ({ output }) =>
      validateOutput(args.cached, output, args.skillName).match(
        () => ({ status: "success", output }),
        (error) => ({ status: "error", error }),
      ),
    )
    .exhaustive();

  const transition = await deps.runInTx((tx) =>
    deps.store.transitionToFinished(tx, { id: runId, verdict }),
  );

  return match(transition)
    .with({ kind: "transitioned" }, () => reconstructFinishedResult(runId, verdict))
    .with({ kind: "already_finished" }, ({ row }) =>
      reconstructFinishedResult(runId, finishedVerdictOf(row)),
    )
    .exhaustive();
}

/** Err with why `output` fails the manifest's `outputs` schema; ok when it declares none. */
function validateOutput(
  cached: SkillSourceCacheEntry,
  output: unknown,
  skillName: string,
): Result<void, string> {
  const validator = cached.outputsValidator;
  if (validator === undefined || validator(output)) return ok(undefined);
  return err(
    `output failed schema validation for skill '${skillName}': ${schemaIssues(validator).join("; ")}`,
  );
}
