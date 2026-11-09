import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { DeployDeps } from "./deploy-deps.js";
import { replacedGitSha } from "./deploy-facts.js";
import type { SkillDeployOrigin } from "./origin.js";
import { restoredCommit, rollbackSkill } from "./rollback.js";

/** The edit rolled back: the version it replaced is live again, or already was. */
export interface RolledBack {
  /**
   * `restored`: this call put that version back. `unchanged`: the skill
   * already ran that version's files. `already_rolled_back`: a later
   * rollback (an earlier tap, or the CLI) put it back. Only `restored` wrote
   * anything.
   */
  kind: "restored" | "unchanged" | "already_rolled_back";
  skillName: string;
  restoredGitSha: string;
  gitSha: string;
}

/** Why a deploy's edit was not rolled back. */
export type RollbackDeployError =
  | { kind: "not_found" }
  /** The deploy did not go live, or replaced no other live version. */
  | { kind: "not_an_edit" }
  /** A later deploy, or a rollback to another version, replaced the deploy's version. */
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
  const restoredGitSha = replacedGitSha(deploy);
  if (deploy.status !== "live" || restoredGitSha === null) return err({ kind: "not_an_edit" });
  const edit = { skillId: skill.id, skillName: skill.name, restoredGitSha };
  if (skill.gitSha !== deploy.gitSha) return liveVersionMoved(deps, edit);

  const result = await rollbackSkill(deps, {
    name: skill.name,
    toGitSha: restoredGitSha,
    origin: args.origin,
    expectedLiveSha: deploy.gitSha,
  });
  return match(result)
    .returnType<Promise<Result<RolledBack, RollbackDeployError>>>()
    .with({ status: "live" }, async (r) =>
      ok({ kind: "restored", skillName: r.name, restoredGitSha, gitSha: r.gitSha }),
    )
    .with({ status: "no_op" }, async (r) =>
      ok({ kind: "unchanged", skillName: r.name, restoredGitSha, gitSha: r.gitSha }),
    )
    .with({ status: "live_version_moved" }, () => liveVersionMoved(deps, edit))
    .with({ status: "rejected" }, async (r) =>
      err({ kind: "refused", reason: r.errors.join("; ") || "rejected" }),
    )
    .with({ status: "pending_approval" }, () => {
      throw new Error("rollbackDeploy: a rollback never leaves a deploy pending");
    })
    .exhaustive();
}

/**
 * The answer for an edit whose version no longer runs: `already_rolled_back`
 * when the live version is a restoring commit whose target is the one a
 * rollback to `restoredGitSha` records, else `superseded`. The skill moved
 * off the edit's sha, so the rollback that put it at that commit came after
 * the edit.
 */
async function liveVersionMoved(
  deps: DeployDeps,
  edit: { skillId: string; skillName: string; restoredGitSha: string },
): Promise<Result<RolledBack, RollbackDeployError>> {
  const live = await deps.runInTx(async (tx) => {
    const skill = await deps.store.getSkillById(tx, edit.skillId);
    // `skills` rows are never deleted, and the edit's row names this one.
    if (!skill) throw new Error(`rollbackDeploy: skill ${edit.skillId} is gone`);
    const target = await deps.store.restoredTargetAt(tx, {
      name: edit.skillName,
      gitSha: skill.gitSha,
    });
    return { gitSha: skill.gitSha, target };
  });
  if (
    live.target === null ||
    live.target !== (await restoredCommit(deps, edit.skillName, edit.restoredGitSha))
  ) {
    return err({ kind: "superseded" });
  }
  return ok({
    kind: "already_rolled_back",
    skillName: edit.skillName,
    restoredGitSha: edit.restoredGitSha,
    gitSha: live.gitSha,
  });
}
