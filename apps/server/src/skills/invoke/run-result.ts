import type { SkillRunStatus } from "../store/index.js";

/** A finished run: what the skill returned, or why it failed. */
export type SkillRunResult =
  | { runId: string; status: "success"; output?: unknown }
  | { runId: string; status: "error"; error: string };

/**
 * Rebuild the public `SkillRunResult` shape from the four fields the
 * `finished` row carries. Centralised so the three return sites (cached
 * replay + new-success + new-error) stay byte-identical and downstream
 * callers can rely on the same shape regardless of which path produced it.
 * An error row always records its reason; `unknown_error` stands in only
 * for a row written outside the runner.
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
  return { runId, status: "error", error: error ?? "unknown_error" };
}
