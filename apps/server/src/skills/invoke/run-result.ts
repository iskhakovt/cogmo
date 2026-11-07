import { match, P } from "ts-pattern";
import type {
  SkillRunError,
  SkillRunErrorKind,
  SkillRunRow,
  SkillRunVerdict,
} from "../store/index.js";

/**
 * A finished run: what the skill returned, or why it failed. An
 * `output_invalid` failure carries what the skill returned, when it returned
 * something, since its effects happened.
 */
export type SkillRunResult =
  | { runId: string; status: "success"; output?: unknown }
  | {
      runId: string;
      status: "error";
      errorKind: Exclude<SkillRunErrorKind, "output_invalid">;
      error: string;
    }
  | {
      runId: string;
      status: "error";
      errorKind: "output_invalid";
      error: string;
      output?: unknown;
    };

/**
 * What a run error means for whoever acts on it (design/skills.md → Run
 * failures): a `defect` counts toward auto-disable, `expected` is the
 * skill's own refusal, `pausing` may clear on a later attempt, `lost` may
 * have acted, and `legacy` predates the kinds.
 */
export type SkillRunErrorClass = "defect" | "expected" | "pausing" | "lost" | "legacy";

export function skillRunErrorClass(kind: SkillRunErrorKind): SkillRunErrorClass {
  return match(kind)
    .returnType<SkillRunErrorClass>()
    .with(
      P.union(
        "skill_raised",
        "output_invalid",
        "load_failed",
        "wall_clock_exceeded",
        "memory_exceeded",
      ),
      () => "defect",
    )
    .with(P.union("skill_failed", "input_invalid"), () => "expected")
    .with(
      P.union(
        "skill_retryable",
        "runtime_unavailable",
        "dependency_unavailable",
        "egress_unavailable",
        "credential_unavailable",
        "host_lost",
      ),
      () => "pausing",
    )
    .with("result_lost", () => "lost")
    .with("unknown", () => "legacy")
    .exhaustive();
}

/**
 * The error a row with `error` set records. `chk_skill_runs_error_kind_with_error`
 * guarantees its kind, so a row without one is an invariant violation.
 */
export function runErrorOf(
  row: Pick<SkillRunRow, "id" | "output" | "error" | "errorKind">,
): SkillRunError | null {
  const { error, errorKind } = row;
  if (error === null) return null;
  if (errorKind === null) throw new Error(`skill run ${row.id} has an error and no error_kind`);
  return match(errorKind)
    .returnType<SkillRunError>()
    .with("output_invalid", (kind) => ({ kind, message: error, output: row.output }))
    .with(P.not("output_invalid"), (kind) => ({ kind, message: error }))
    .exhaustive();
}

/**
 * The verdict a `finished` row holds. `chk_skill_runs_status_iff_finished`
 * and `chk_skill_runs_outcome` guarantee the shape — a terminal status, and a
 * reason on an error — so a row outside it is an invariant violation.
 */
export function finishedVerdictOf(
  row: Pick<SkillRunRow, "id" | "status" | "output" | "error" | "errorKind">,
): SkillRunVerdict {
  return match(row.status)
    .returnType<SkillRunVerdict>()
    .with("success", () => ({ status: "success", output: row.output }))
    .with("error", () => {
      const error = runErrorOf(row);
      if (error === null) {
        throw new Error(`skill run ${row.id} finished with status 'error' and no error`);
      }
      return { status: "error", error };
    })
    .with("running", () => {
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
    .with({ status: "error" }, ({ error }) => errorResult(runId, error))
    .exhaustive();
}

function errorResult(runId: string, error: SkillRunError): SkillRunResult {
  return match(error)
    .returnType<SkillRunResult>()
    .with({ kind: "output_invalid" }, ({ kind, message, output }) => ({
      runId,
      status: "error",
      errorKind: kind,
      error: message,
      ...(output !== null && { output }),
    }))
    .with({ kind: P.not("output_invalid") }, ({ kind, message }) => ({
      runId,
      status: "error",
      errorKind: kind,
      error: message,
    }))
    .exhaustive();
}
