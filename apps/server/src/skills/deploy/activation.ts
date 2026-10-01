import type { DeployDeps } from "./deploy-deps.js";
import { deployRunAs, type SkillDeployOrigin } from "./origin.js";

/**
 * Failure reasons for {@link enableSkill}. Exposed as a discriminated
 * union (rather than thrown errors) because the call sites — Telegram
 * adapter, CLI — render each case with a different user-facing message and
 * we want exhaustiveness checking instead of string parsing.
 */
export type EnableFailureReason = "not_found" | "no_live_deploy";

export type EnableResult =
  /** `schedule`: the schedule this enable put live, now running as its origin. */
  | { kind: "enabled"; name: string; gitSha: string; schedule: string | null }
  | { kind: "already_enabled"; name: string; gitSha: string }
  | { kind: "rejected"; name: string; reason: EnableFailureReason };

/**
 * Mirror of {@link EnableResult} for {@link deregisterSkill}.
 * Returning a discriminated union (rather than throwing on "not found")
 * lets transport adapters map cases without string-matching the error
 * message — a fragile coupling to the runner's wording. Only `not_found`
 * is a domain failure; DB / infrastructure errors still throw.
 */
export type DeregisterFailureReason = "not_found";

export type DeregisterResult =
  | { kind: "deregistered"; name: string }
  | { kind: "rejected"; name: string; reason: DeregisterFailureReason };

/** Soft-disable a skill. */
export async function deregisterSkill(
  deps: Pick<DeployDeps, "store" | "runInTx">,
  opts: { name: string },
): Promise<DeregisterResult> {
  return deps.runInTx(async (tx) => {
    const skill = await deps.store.getSkillByName(tx, opts.name);
    if (!skill) {
      return { kind: "rejected", name: opts.name, reason: "not_found" } as const;
    }
    // Soft-disable rather than physically deleting — preserves the audit
    // trail in skill_deploys and skill_runs. A future hard-delete RPC could
    // exist, but at personal scale soft-disable covers the use case (revoke
    // an unsafe skill, retain the history). `disableSkill` is idempotent
    // at the store layer, so calling deregister on an already-disabled
    // row is a SQL no-op and returns `deregistered`.
    await deps.store.disableSkill(tx, skill.id);
    return { kind: "deregistered", name: skill.name } as const;
  });
}

/** Re-activate a soft-disabled skill whose current sha was live before. */
export async function enableSkill(
  deps: Pick<DeployDeps, "store" | "runInTx" | "defaultRunAs">,
  opts: { name: string; origin: SkillDeployOrigin },
): Promise<EnableResult> {
  return deps.runInTx(async (tx) => {
    const skill = await deps.store.getSkillByName(tx, opts.name);
    if (!skill) {
      return { kind: "rejected", name: opts.name, reason: "not_found" } as const;
    }
    if (!skill.disabled) {
      return {
        kind: "already_enabled",
        name: skill.name,
        gitSha: skill.gitSha,
      } as const;
    }
    // Approval-gate guard: a `disabled=true` row with no matching live
    // deploy means the current sha was either denied at first registration
    // or has otherwise never been signed off. Flipping disabled=false
    // here would activate that code with no human review — the same hole
    // a `/disable foo` → `/enable foo` cycle would open if /disable
    // weren't already gated to live skills upstream. Refuse, force the
    // operator through `register` again.
    const hasLive = await deps.store.hasLiveDeployForSkill(tx, {
      skillId: skill.id,
      gitSha: skill.gitSha,
    });
    if (!hasLive) {
      return { kind: "rejected", name: skill.name, reason: "no_live_deploy" } as const;
    }
    await deps.store.enableSkill(tx, {
      id: skill.id,
      runAs: deployRunAs(deps.defaultRunAs, opts.origin),
    });
    return {
      kind: "enabled",
      name: skill.name,
      gitSha: skill.gitSha,
      schedule: skill.schedule,
    } as const;
  });
}
