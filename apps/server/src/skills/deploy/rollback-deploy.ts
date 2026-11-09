import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { DeployDeps } from "./deploy-deps.js";
import type { SkillDeployOrigin } from "./origin.js";
import { rollbackSkill } from "./rollback.js";

/** The edit rolled back: the version it replaced is live again, or already was. */
export interface RolledBack {
  /** `unchanged`: the skill already ran that version's files; nothing was written. */
  kind: "restored" | "unchanged";
  skillName: string;
  restoredGitSha: string;
  gitSha: string;
}

/** Why a deploy's edit was not rolled back. */
export type RollbackDeployError =
  | { kind: "not_found" }
  /** The deploy did not go live, or replaced no live version. */
  | { kind: "not_an_edit" }
  /** A later deploy or rollback replaced the deploy's version. */
  | { kind: "superseded" }
  | { kind: "refused"; reason: string };

/**
 * Roll back the edit deploy `deployId` made, as its live message's Roll back
 * button names it: restore the version it replaced through the forward
 * rollback, refused once the deploy is no longer the skill's live version —
 * read here for a precise answer, and checked again by the rollback, inside
 * its transaction (design/skills.md → Notifications and undo).
 */
export async function rollbackDeploy(
  deps: DeployDeps,
  args: { deployId: string; origin: SkillDeployOrigin },
): Promise<Result<RolledBack, RollbackDeployError>> {
  const found = await deps.runInTx(async (tx) => {
    const deploy = await deps.store.getDeployById(tx, args.deployId);
    if (!deploy) return undefined;
    const skill = await deps.store.getSkillById(tx, deploy.skillId);
    // `skill_deploys.skill_id` references `skills.id`.
    if (!skill) throw new Error(`rollbackDeploy: deploy ${deploy.id} names no skill`);
    return { deploy, skill };
  });
  if (!found) return err({ kind: "not_found" });
  const { deploy, skill } = found;
  const restoredGitSha = deploy.priorGitSha;
  if (deploy.status !== "live" || restoredGitSha === null) return err({ kind: "not_an_edit" });
  if (skill.gitSha !== deploy.gitSha) return err({ kind: "superseded" });

  const result = await rollbackSkill(deps, {
    name: skill.name,
    toGitSha: restoredGitSha,
    origin: args.origin,
    expectedLiveSha: deploy.gitSha,
  });
  return match(result)
    .returnType<Result<RolledBack, RollbackDeployError>>()
    .with({ status: "live" }, (r) =>
      ok({ kind: "restored", skillName: r.name, restoredGitSha, gitSha: r.gitSha }),
    )
    .with({ status: "no_op" }, (r) =>
      ok({ kind: "unchanged", skillName: r.name, restoredGitSha, gitSha: r.gitSha }),
    )
    .with({ status: "live_version_moved" }, () => err({ kind: "superseded" }))
    .with({ status: "rejected" }, (r) =>
      err({ kind: "refused", reason: r.errors.join("; ") || "rejected" }),
    )
    .with({ status: "pending_approval" }, () => {
      throw new Error("rollbackDeploy: a rollback never leaves a deploy pending");
    })
    .exhaustive();
}
