import { match, P } from "ts-pattern";
import type { SkillRunRow, SkillRunVerdict } from "../store/index.js";

/** What an executed run produced, as its `executed` row records it. */
export type ExecutedOutcome =
  | { kind: "output"; output: unknown | null }
  | { kind: "error"; error: string };

/** A finished run: what the skill returned, or why it failed. */
export type SkillRunResult =
  | { runId: string; status: "success"; output?: unknown }
  | { runId: string; status: "error"; error: string };

/**
 * The verdict a `finished` row holds. `chk_skill_runs_status_iff_finished`
 * and `chk_skill_runs_outcome` guarantee the shape — a terminal status, and a
 * reason on an error — so a row outside it is an invariant violation.
 */
export function finishedVerdictOf(
  row: Pick<SkillRunRow, "id" | "status" | "output" | "error">,
): SkillRunVerdict {
  return match(row)
    .returnType<SkillRunVerdict>()
    .with({ status: "success" }, ({ output }) => ({ status: "success", output }))
    .with({ status: "error", error: P.string }, ({ error }) => ({ status: "error", error }))
    .with({ status: "error", error: null }, () => {
      throw new Error(`skill run ${row.id} finished with status 'error' and no error`);
    })
    .with({ status: "running" }, () => {
      throw new Error(`skill run ${row.id} finished with status 'running'`);
    })
    .exhaustive();
}

/**
 * The public `SkillRunResult` shape of a verdict. Centralised so the three
 * return sites (cached replay + new-success + new-error) stay byte-identical
 * and downstream callers can rely on the same shape regardless of which path
 * produced it.
 */
export function reconstructFinishedResult(runId: string, verdict: SkillRunVerdict): SkillRunResult {
  return match(verdict)
    .returnType<SkillRunResult>()
    .with({ status: "success" }, ({ output }) => ({
      runId,
      status: "success",
      ...(output !== null && { output }),
    }))
    .with({ status: "error" }, ({ error }) => ({ runId, status: "error", error }))
    .exhaustive();
}
