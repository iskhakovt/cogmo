import { classifyManifest } from "../classifier.js";
import { getMainSha, revParse, updateRef } from "../git-ops.js";
import { readSkillSource } from "../skill-source.js";
import { type DeployDeps, requireRepoPath, ZERO_SHA } from "./deploy-deps.js";
import { readManifestLockfile } from "./lockfile-check.js";
import { mirrorMainToRemote } from "./mirror.js";
import { deployRunAs, type SkillDeployOrigin } from "./origin.js";
import { type RegisterResult, rejectedResult, targetSourceRejection } from "./register-result.js";

/**
 * Rewind a skill to an earlier sha of its own: re-check that sha's source,
 * move main back onto it in one transaction, and force-mirror main to the
 * remote under a lease.
 */
export async function rollbackSkill(
  deps: DeployDeps,
  opts: { name: string; toGitSha: string; origin: SkillDeployOrigin },
): Promise<RegisterResult> {
  const repoPath = requireRepoPath(deps, "rollback");

  const resolved = await revParse(repoPath, opts.toGitSha);
  if (resolved.isErr()) {
    return rejectedResult(opts.toGitSha, `target_sha_not_found: ${opts.toGitSha}`);
  }
  const targetSha = resolved.value;

  // Re-read the manifest at the target sha. We need it for two things:
  // (a) verify manifest.name matches opts.name — without this, rolling
  // back skill X to a sha that originally belonged to skill Y would
  // silently rebind X to Y's code; (b) project the full set of
  // manifest-derived columns (tier, effects, schedule, inputs, outputs,
  // riskTier) into the skills row, so tool definitions and validation
  // reflect what's actually on disk at the rolled-back sha.
  const source = await readSkillSource(repoPath, targetSha);
  if (source.isErr()) return rejectedResult(targetSha, targetSourceRejection(source.error));
  const { manifest, body } = source.value;

  if (manifest.name !== opts.name) {
    return rejectedResult(
      targetSha,
      `target_skill_mismatch: target sha belongs to skill '${manifest.name}', not '${opts.name}'`,
    );
  }

  const schemaErrors = deps.sourceCache.prevalidate(manifest);
  if (schemaErrors.length > 0) {
    return {
      name: opts.name,
      riskTier: "notify",
      status: "rejected",
      gitSha: targetSha,
      errors: schemaErrors,
    };
  }

  const classifierLog = await classifyManifest(manifest, body);
  if (classifierLog.validation_errors.length > 0) {
    // Same UX-gate semantics as `register`: a target sha whose body
    // declares effects out of sync with the manifest is a foot-gun
    // operators want flagged before main rewinds.
    return rejectedResult(targetSha, classifierLog.validation_errors.join("; "));
  }

  const mainSha = await getMainSha(repoPath);

  // Trust the historical lockfile: it was valid at deploy time and
  // its hashes are still pinned. A wheel yanked since shouldn't
  // block rewinding to a known-good revision.
  const lockfileResult = await readManifestLockfile(
    deps.lockfileCompiler,
    repoPath,
    targetSha,
    manifest,
    { verifyFresh: false },
  );
  if (lockfileResult.isErr()) {
    return rejectedResult(targetSha, lockfileResult.error);
  }
  const lockfile = lockfileResult.value;

  const schedule = manifest.schedule ?? null;
  const result = await deps.runInTx((tx) =>
    deps.store.executeRollback(tx, {
      name: opts.name,
      toGitSha: targetSha,
      tier: manifest.tier,
      riskTier: classifierLog.risk_tier,
      effects: manifest.effects,
      schedule,
      scheduleNextRunAt: deps.scheduleNextRunAt(schedule),
      lockfileHash: lockfile?.hash ?? null,
      inputs: manifest.inputs,
      outputs: manifest.outputs ?? null,
      classifierLog,
      runAs: deployRunAs(deps.defaultRunAs, opts.origin),
      applyFilesystem: async () => {
        // Rollback rewrites main backward — pre-receive hook would normally
        // reject this, but `update-ref` bypasses hooks by design (see
        // bootstrapSkillsRepo). Pass `mainSha` as expectedOldSha for CAS.
        await updateRef(repoPath, "refs/heads/main", targetSha, mainSha ?? ZERO_SHA);
      },
    }),
  );

  // Warm the source cache with the rolled-back manifest+body so the next
  // invoke or listToolDefs read doesn't re-fetch from git.
  if (result.kind === "live") {
    deps.sourceCache.put(targetSha, { manifest, body }, lockfile);
    // Rollback rewinds main backwards, so the remote push needs `force`. We
    // gate with `--force-with-lease=refs/heads/main:<mainSha>` — if anything
    // moved remote main between our last fetch and this push, the lease
    // fails and the operator is told to investigate rather than silently
    // overwriting a divergent remote. `mainSha` is null when local main is
    // unborn (first ever register-then-rollback before any pushes
    // succeeded); `ZERO_SHA` is git's convention for "ref must not exist"
    // in lease syntax, which is the correct lease for that edge.
    await mirrorMainToRemote(deps, repoPath, targetSha, {
      force: { expectedRemoteSha: mainSha ?? ZERO_SHA },
    });
  }

  if (result.kind === "live") {
    return {
      name: result.skill.name,
      riskTier: result.skill.riskTier,
      status: "live",
      gitSha: result.skill.gitSha,
    };
  }
  if (result.kind === "no_op") {
    return {
      name: result.skill.name,
      riskTier: result.skill.riskTier,
      status: "no_op",
      gitSha: result.skill.gitSha,
    };
  }
  return rejectedResult(targetSha, result.kind === "rejected" ? result.reason : result.kind);
}
