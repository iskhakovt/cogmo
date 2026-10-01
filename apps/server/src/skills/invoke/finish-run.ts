import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import type { SkillSourceCacheEntry } from "../source-cache.js";
import type { SkillRunStatus, SkillStore } from "../store/index.js";
import { reconstructFinishedResult, type SkillRunResult } from "./run-result.js";
import type { ExecutedOutcome } from "./start-run.js";

/**
 * The `executed → finished` transition: validate the executed output against
 * the manifest's `outputs` schema and settle the run's terminal status.
 * Validation is pure, so a recovered `executed` row reaches the verdict the
 * original attempt would have.
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
  const { runId, executed } = args;
  let finalStatus: SkillRunStatus;
  let finalOutput: unknown | null;
  let finalError: string | null;
  if (executed.kind === "error") {
    finalStatus = "error";
    finalOutput = null;
    finalError = executed.error;
  } else {
    const valid = validateOutput(args.cached, executed.output, args.skillName);
    if (valid.isErr()) {
      finalStatus = "error";
      finalOutput = null;
      finalError = valid.error;
    } else {
      finalStatus = "success";
      finalOutput = executed.output;
      finalError = null;
    }
  }

  await deps.runInTx((tx) =>
    deps.store.transitionToFinished(tx, {
      id: runId,
      status: finalStatus,
      output: finalOutput,
      error: finalError,
    }),
  );

  return reconstructFinishedResult(runId, finalStatus, finalOutput, finalError);
}

/** Err with why `output` fails the manifest's `outputs` schema; ok when it declares none. */
function validateOutput(
  cached: SkillSourceCacheEntry,
  output: unknown,
  skillName: string,
): Result<void, string> {
  const validator = cached.outputsValidator;
  if (validator === undefined || validator(output)) return ok(undefined);
  const issues = (validator.errors ?? []).map(
    (e) => `${e.instancePath || "<root>"} ${e.message ?? "invalid"}`,
  );
  return err(`output failed schema validation for skill '${skillName}': ${issues.join("; ")}`);
}
