import { match } from "ts-pattern";

/**
 * Why `invoke` declined to run a skill. Nothing executed. Only `inflight`
 * has a run row: the one a prior attempt under the same idempotency key
 * left at `recovery_point='started'`. The runner can't tell a crashed
 * attempt from one still executing, and re-executing either risks firing
 * the skill's side effects twice, so it declines and names the row for an
 * operator to inspect (design/skills.md → Exactly-once invocation).
 */
export type SkillInvokeRejection =
  | { kind: "not_found"; name: string }
  | { kind: "disabled"; name: string }
  | { kind: "invalid_inputs"; name: string; issues: readonly string[] }
  /** A `tier: container` skill on a deployment with no sandbox configured. */
  | { kind: "sandbox_unavailable"; name: string }
  | { kind: "inflight"; name: string; runId: string };

/** One line naming the rejection, for logs and operator-facing output. */
export function describeInvokeRejection(rejection: SkillInvokeRejection): string {
  return match(rejection)
    .with({ kind: "not_found" }, ({ name }) => `skill not found: ${name}`)
    .with({ kind: "disabled" }, ({ name }) => `skill is disabled: ${name}`)
    .with(
      { kind: "invalid_inputs" },
      ({ name, issues }) =>
        `inputs failed schema validation for skill '${name}': ${issues.join("; ")}`,
    )
    .with(
      { kind: "sandbox_unavailable" },
      ({ name }) =>
        `skill '${name}' is tier=container but no sandbox is configured (set SANDBOX_RUNTIME)`,
    )
    .with(
      { kind: "inflight" },
      ({ name, runId }) =>
        `skill '${name}' has an in-flight run (id=${runId}) — prior attempt may have crashed mid-execute or another worker is currently executing`,
    )
    .exhaustive();
}
