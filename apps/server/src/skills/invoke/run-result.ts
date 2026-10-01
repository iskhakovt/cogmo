import type { SkillRunStatus } from "../store/index.js";

export interface SkillRunResult {
  runId: string;
  status: "success" | "error";
  output?: unknown;
  error?: string;
}

/**
 * Rebuild the public `SkillRunResult` shape from the four fields the
 * `finished` row carries. Centralised so the three return sites (cached
 * replay + new-success + new-error) stay byte-identical and downstream
 * callers can rely on the same shape regardless of which path produced it.
 */
export function reconstructFinishedResult(
  runId: string,
  status: SkillRunStatus,
  output: unknown | null,
  error: string | null,
): SkillRunResult {
  if (status === "success") {
    return {
      runId,
      status: "success",
      ...(output !== null && { output }),
    };
  }
  return {
    runId,
    status: "error",
    ...(error !== null && { error }),
  };
}
