import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import { getMainSha, isAncestor } from "../git-ops.js";
import { readSkillSource } from "../skill-source.js";
import type { SkillDeployStatus } from "../store/index.js";
import { advanceMain, runDeployTx } from "./advance-main.js";
import { type DeployDeps, requireRepoPath } from "./deploy-deps.js";
import { readManifestLockfile } from "./lockfile-check.js";
import { mirrorMainToRemote } from "./mirror.js";
import { deployRunAs, type SkillDeployOrigin } from "./origin.js";
import { type RegisterResult, rejectedResult, targetSourceRejection } from "./register-result.js";

const log = logger.child({ component: "skills.runner" });

/**
 * Put a pending deploy live: re-check it against main and its source, then
 * advance main onto it in one transaction and mirror main to the remote.
 */
export async function approveDeploy(
  deps: DeployDeps,
  opts: { pendingId: string; origin: SkillDeployOrigin },
): Promise<RegisterResult> {
  const repoPath = requireRepoPath(deps, "approveDeploy");

  const deploy = await deps.runInTx((tx) => deps.store.getDeployById(tx, opts.pendingId));
  if (!deploy) {
    return rejectedResult("", `deploy_not_found: ${opts.pendingId}`);
  }
  if (deploy.status !== "pending_approval") {
    return rejectedResult(deploy.gitSha, `deploy_not_pending: status is '${deploy.status}'`);
  }

  const skill = await deps.runInTx((tx) => deps.store.getSkillById(tx, deploy.skillId));
  if (!skill) {
    return rejectedResult(deploy.gitSha, "skill_not_found");
  }

  const mainSha = await getMainSha(repoPath);
  // Fast-forward check at approve time too — main may have moved since the
  // approve-tier deploy was created. Repeated under the lock by `advanceMain`.
  if (mainSha && !(await isAncestor(repoPath, mainSha, deploy.gitSha))) {
    return rejectedResult(deploy.gitSha, "non_fast_forward_at_approve_time");
  }

  // Re-read the manifest at deploy.gitSha so executeApprove can write the
  // full set of manifest-derived columns (tier/effects/inputs/outputs/etc.)
  // alongside gitSha. Without this projection the row would still reflect
  // the prior live commit's manifest while pointing at the approved sha,
  // which would silently mismatch tool definitions and ajv input
  // validation against the actual code on disk.
  const source = await readSkillSource(repoPath, deploy.gitSha);
  if (source.isErr()) return rejectedResult(deploy.gitSha, targetSourceRejection(source.error));
  const { manifest, body } = source.value;

  if (manifest.name !== skill.name) {
    return rejectedResult(
      deploy.gitSha,
      `target_skill_mismatch: deploy sha belongs to skill '${manifest.name}', not '${skill.name}'`,
    );
  }

  const schemaErrors = deps.sourceCache.prevalidate(manifest);
  if (schemaErrors.length > 0) {
    return {
      name: skill.name,
      riskTier: deploy.riskTier,
      status: "rejected",
      gitSha: deploy.gitSha,
      errors: schemaErrors,
    };
  }

  const lockfileResult = await readManifestLockfile(
    deps.lockfileCompiler,
    repoPath,
    deploy.gitSha,
    manifest,
    { verifyFresh: true },
  );
  if (lockfileResult.isErr()) {
    return rejectedResult(deploy.gitSha, lockfileResult.error);
  }
  const lockfile = lockfileResult.value;

  const schedule = manifest.schedule ?? null;
  const executed = await runDeployTx(deps.runInTx, (tx) =>
    deps.store.executeApprove(tx, {
      pendingId: opts.pendingId,
      approvedBy: opts.origin.kind === "user" ? opts.origin.actor.identityId : null,
      tier: manifest.tier,
      // Preserve the deploy row's classified tier (which is what the user
      // approved). Re-classifying here could promote an `approve` deploy to a
      // different tier mid-flow, which would be confusing.
      riskTier: deploy.riskTier,
      effects: manifest.effects,
      schedule,
      scheduleNextRunAt: deps.scheduleNextRunAt(schedule),
      lockfileHash: lockfile?.hash ?? null,
      inputs: manifest.inputs,
      outputs: manifest.outputs ?? null,
      runAs: deployRunAs(deps.defaultRunAs, opts.origin),
      applyFilesystem: async () => {
        await advanceMain(repoPath, deploy.gitSha, { kind: "fast_forward" });
      },
    }),
  );
  if (executed.isErr()) return rejectedResult(deploy.gitSha, "non_fast_forward_at_approve_time");
  const result = executed.value;

  if (result.kind === "live") {
    // Warm the source cache with the just-approved manifest so the next
    // listToolDefs / invoke read doesn't re-fetch from git.
    deps.sourceCache.put(deploy.gitSha, { manifest, body }, lockfile);
    // Mirror the new main SHA to the configured remote — same rationale as
    // register's mirror call.
    await mirrorMainToRemote(deps, repoPath, deploy.gitSha);
    return {
      name: result.skill.name,
      riskTier: result.skill.riskTier,
      status: "live",
      gitSha: result.skill.gitSha,
    };
  }
  return rejectedResult(deploy.gitSha, result.kind === "rejected" ? result.reason : result.kind);
}

/**
 * Why a deny resolved nothing. `not_pending` carries the status the row
 * holds, so a second tap or a late CLI call reads as "already resolved".
 */
export type DenyDeployError =
  | { kind: "not_found"; pendingId: string }
  | { kind: "not_pending"; pendingId: string; status: SkillDeployStatus };

/** One line naming the miss, for the CLI and logs. */
export function describeDenyDeployError(error: DenyDeployError): string {
  return match(error)
    .with({ kind: "not_found" }, ({ pendingId }) => `deploy not found: ${pendingId}`)
    .with(
      { kind: "not_pending" },
      ({ pendingId, status }) => `deploy ${pendingId} is not pending: status is '${status}'`,
    )
    .exhaustive();
}

/**
 * Resolve a pending deploy as denied; main does not move. The reason has no
 * column on the row, so the log line of the transition is its record.
 */
export async function denyDeploy(
  deps: Pick<DeployDeps, "store" | "runInTx">,
  opts: { pendingId: string; reason?: string },
): Promise<Result<void, DenyDeployError>> {
  const transition = await deps.runInTx((tx) =>
    deps.store.denyPendingDeploy(tx, { pendingId: opts.pendingId }),
  );
  return match(transition)
    .returnType<Result<void, DenyDeployError>>()
    .with({ kind: "transitioned" }, () => {
      log.info({ pendingId: opts.pendingId, reason: opts.reason ?? null }, "skill deploy denied");
      return ok(undefined);
    })
    .with({ kind: "not_found" }, () => err({ kind: "not_found", pendingId: opts.pendingId }))
    .with({ kind: "not_pending" }, ({ status }) =>
      err({ kind: "not_pending", pendingId: opts.pendingId, status }),
    )
    .exhaustive();
}
