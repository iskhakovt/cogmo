import { match } from "ts-pattern";
import { classifyManifest } from "../classifier.js";
import {
  commitAsCogmo,
  logCommits,
  madeByCogmo,
  pathsUnder,
  RESTORES_TRAILER,
  type TreeEdit,
  writeEditedTree,
} from "../cogmo-commits.js";
import type { LockfileSnapshot } from "../deps.js";
import { getMainSha, revParse } from "../git-ops.js";
import {
  type SkillsRepo,
  sameSkillBlobs,
  skillBlobsAt,
  skillBlobsMatchAt,
  skillBlobsUnder,
  skillDir,
} from "../skill-files.js";
import { readSkillSource, type SkillSource } from "../skill-source.js";
import type { ClassifierLog, SkillSchemas } from "../types.js";
import { advanceMain, runDeployTx } from "./advance-main.js";
import { type DeployDeps, requireRepo } from "./deploy-deps.js";
import { deployFacts } from "./deploy-facts.js";
import { readManifestLockfile } from "./lockfile-check.js";
import { mirrorMain } from "./mirror.js";
import { deployRunAs, type SkillDeployOrigin } from "./origin.js";
import { type RegisterResult, rejectedResult, targetSourceRejection } from "./register-result.js";
import { frontmatterSchemas } from "./schemas.js";

/**
 * Roll a skill back to an earlier sha of its own: re-check that sha's
 * source, then commit its files to `skills/<name>/` on top of `main` (the
 * restoring commit) and put that commit live in one transaction, so `main`
 * only fast-forwards and no other skill's files move
 * (design/skills.md → Deploy lifecycle). `expectedLiveSha`, when not null,
 * must still be the skill's live sha, else `live_version_moved`; checked
 * here and again inside the transaction.
 */
export async function rollbackSkill(
  deps: DeployDeps,
  opts: {
    name: string;
    toGitSha: string;
    origin: SkillDeployOrigin;
    expectedLiveSha: string | null;
  },
): Promise<RegisterResult | LiveVersionMoved> {
  const repo = requireRepo(deps, "rollback");
  const repoPath = repo.path;

  const resolved = await revParse(repoPath, `${opts.toGitSha}^{commit}`);
  if (resolved.isErr()) {
    return rejectedResult(opts.toGitSha, `target_sha_not_found: ${opts.toGitSha}`);
  }
  const targetSha = resolved.value;

  // The target's manifest must name the skill — otherwise rolling X back
  // to Y's sha would rebind X to Y's code — and it supplies the
  // manifest-derived columns of the skills row.
  const source = await readSkillSource(repo, opts.name, targetSha);
  if (source.isErr()) return rejectedResult(targetSha, targetSourceRejection(source.error));
  const { manifest, body } = source.value;

  if (manifest.name !== opts.name) {
    return rejectedResult(
      targetSha,
      `target_skill_mismatch: target sha belongs to skill '${manifest.name}', not '${opts.name}'`,
    );
  }

  // The schemas the target went live with, as its deploy recorded them; a
  // deploy from before they were recorded had its frontmatter declare them.
  const schemas =
    (await deps.runInTx((tx) =>
      deps.store.liveDeploySchemas(tx, { name: opts.name, gitSha: targetSha }),
    )) ?? frontmatterSchemas(manifest);
  if (schemas === null) {
    return rejectedResult(
      targetSha,
      "schemas_unknown: no deploy of the target sha recorded its schemas, and its SKILL.md declares no inputs",
    );
  }
  const schemaErrors = deps.sourceCache.prevalidate(schemas);
  if (schemaErrors.length > 0) {
    return {
      name: opts.name,
      riskTier: "notify",
      status: "rejected",
      gitSha: targetSha,
      errors: schemaErrors,
    };
  }

  // No register-time gate runs: a gate added since must not put a version
  // that worked out of reach. The classifier rejects an undeclared effect
  // only when a row other than a ctx row detected it.
  const classifierLog = await classifyManifest(manifest, body, deps.capabilities);
  if (classifierLog.validation_errors.length > 0) {
    return rejectedResult(targetSha, classifierLog.validation_errors.join("; "));
  }

  // Trust the historical lockfile: it was valid at deploy time and
  // its hashes are still pinned. A wheel yanked since shouldn't
  // block rolling back to a known-good revision.
  const lockfileResult = await readManifestLockfile(
    deps.lockfileCompiler,
    repo,
    targetSha,
    manifest,
    { verifyFresh: false },
  );
  if (lockfileResult.isErr()) {
    return rejectedResult(targetSha, lockfileResult.error);
  }
  const lockfile = lockfileResult.value;

  const restores = await restoredCommit(deps, opts.name, targetSha);
  const mainSha = await getMainSha(repoPath);
  if (mainSha === null) {
    throw new Error("rollback: the skills repo's main is unborn; boot makes the layout commit");
  }
  const restoring = await restoringCommit(deps, repo, {
    name: opts.name,
    targetSha,
    restores,
    mainSha,
    expectedLiveSha: opts.expectedLiveSha,
  });
  return match(restoring)
    .returnType<Promise<RegisterResult | LiveVersionMoved> | RegisterResult | LiveVersionMoved>()
    .with({ kind: "moved" }, () => ({ status: "live_version_moved" as const }))
    .with(
      { kind: "unchanged" },
      ({ skill }): RegisterResult => ({
        name: opts.name,
        riskTier: skill.riskTier,
        status: "no_op",
        gitSha: skill.gitSha,
      }),
    )
    .with({ kind: "restore" }, (restore) =>
      putRestoringLive(deps, repoPath, {
        name: opts.name,
        targetSha,
        restores,
        mainSha,
        restore,
        source: { manifest, body },
        schemas,
        lockfile,
        classifierLog,
        origin: opts.origin,
        expectedLiveSha: opts.expectedLiveSha,
      }),
    )
    .exhaustive();
}

/**
 * The rollback's transaction: `skills` at the restoring commit and the
 * `rolled_back` row, with `main` moved to `restore.mainAfter` only if it is
 * still the `main` the restoring commit was chosen against; then the mirror.
 */
async function putRestoringLive(
  deps: DeployDeps,
  repoPath: string,
  args: {
    name: string;
    targetSha: string;
    restores: string;
    mainSha: string;
    restore: { sha: string; mainAfter: string };
    source: SkillSource;
    schemas: SkillSchemas;
    lockfile: LockfileSnapshot | null;
    classifierLog: ClassifierLog;
    origin: SkillDeployOrigin;
    expectedLiveSha: string | null;
  },
): Promise<RegisterResult | LiveVersionMoved> {
  const { name, targetSha, restores, mainSha, restore, source, schemas, lockfile } = args;
  const { manifest } = source;
  const schedule = manifest.schedule ?? null;
  const executed = await runDeployTx(deps.runInTx, (tx) =>
    deps.store.executeRollback(tx, {
      name,
      restoringGitSha: restore.sha,
      restoresGitSha: restores,
      expectedLiveSha: args.expectedLiveSha,
      tier: manifest.tier,
      riskTier: args.classifierLog.risk_tier,
      effects: manifest.effects,
      schedule,
      scheduleNextRunAt: deps.scheduleNextRunAt(schedule),
      lockfileHash: lockfile?.hash ?? null,
      inputs: schemas.inputs,
      outputs: schemas.outputs,
      classifierLog: args.classifierLog,
      runAs: deployRunAs(deps.defaultRunAs, args.origin),
      applyFilesystem: async () => {
        // A deploy of this skill that landed since would otherwise be
        // overwritten in the database, or dropped from main.
        // Also when main does not move: a recovered restoring commit's crash
        // may have left the mirror state behind main.
        await deps.store.markMainAdvanced(tx, restore.mainAfter);
        await advanceMain(repoPath, restore.mainAfter, { kind: "unchanged", expected: mainSha });
      },
    }),
  );
  if (executed.isErr()) {
    return rejectedResult(targetSha, "main_moved: main changed during the rollback; retry");
  }
  return match(executed.value)
    .returnType<Promise<RegisterResult | LiveVersionMoved>>()
    .with({ kind: "live" }, async (result) => {
      // Warm the source cache so the next invoke or listToolDefs read
      // doesn't re-fetch from git.
      deps.sourceCache.put(restore.sha, source, schemas, lockfile);
      // A plain push of main, which only moved forward; a recovered restoring
      // commit may not have reached the remote either.
      await mirrorMain(deps, repoPath, restore.mainAfter);
      return {
        name: result.skill.name,
        riskTier: result.skill.riskTier,
        status: "live",
        gitSha: result.skill.gitSha,
        skillId: result.skill.id,
        deployId: result.deploy.id,
        facts: deployFacts(manifest, result.deploy),
      };
    })
    .with({ kind: "no_op" }, async (result) => ({
      name: result.skill.name,
      riskTier: result.skill.riskTier,
      status: "no_op",
      gitSha: result.skill.gitSha,
    }))
    .with({ kind: "live_version_moved" }, async () => ({ status: "live_version_moved" }))
    .with({ kind: "rejected" }, async (result) => rejectedResult(targetSha, result.reason))
    .with({ kind: "pending_approval" }, () => {
      throw new Error("rollback: executeRollback never leaves a deploy pending");
    })
    .exhaustive();
}

/** A rollback refused because the caller's expected live sha is no longer the skill's. */
export interface LiveVersionMoved {
  status: "live_version_moved";
}

/**
 * What a rollback to `targetSha` restores: the target, or, when the target is
 * itself a restoring commit, the commit that one restored, so the value
 * always names a commit that had its own deploy.
 */
export async function restoredCommit(
  deps: DeployDeps,
  name: string,
  targetSha: string,
): Promise<string> {
  return (
    (await deps.runInTx((tx) => deps.store.restoredTargetAt(tx, { name, gitSha: targetSha }))) ??
    targetSha
  );
}

/** What a rollback puts live. */
type Restoring =
  /** The enabled skill already runs the target's files: nothing to do. */
  | { kind: "unchanged"; skill: { gitSha: string; riskTier: RegisterResult["riskTier"] } }
  /** The caller's expected live sha is no longer the skill's. */
  | { kind: "moved" }
  /**
   * `sha`, a commit whose `skills/<name>/` holds the target's files, with
   * `main` at `mainAfter` once it is live: a new restoring commit on top of
   * `main` (`main` moves to it), or a commit `main` already holds — the
   * restoring commit a crash left with no row, or `main` itself.
   */
  | { kind: "restore"; sha: string; mainAfter: string };

async function restoringCommit(
  deps: DeployDeps,
  repo: SkillsRepo,
  args: {
    name: string;
    targetSha: string;
    restores: string;
    mainSha: string;
    expectedLiveSha: string | null;
  },
): Promise<Restoring> {
  const { name, targetSha, restores, mainSha } = args;
  const target = await skillBlobsAt(repo, name, targetSha);

  // Recovery: the newest first-parent commit on main that changes the
  // skill's directory is this rollback's restoring commit, which a crash
  // after `update-ref` left with no row.
  const [latest] = await logCommits(repo.path, [
    "--first-parent",
    "-1",
    mainSha,
    "--",
    skillDir(name),
  ]);
  if (
    latest !== undefined &&
    madeByCogmo(latest) &&
    latest.trailers.get(RESTORES_TRAILER) === restores &&
    !(await deps.runInTx((tx) => deps.store.hasDeployAt(tx, latest.sha)))
  ) {
    return { kind: "restore", sha: latest.sha, mainAfter: mainSha };
  }

  const skill = await deps.runInTx((tx) => deps.store.getSkillByName(tx, name));
  // Checked again in the transaction; here it keeps a stale caller from the
  // `unchanged` answer below, which never reaches the transaction.
  if (args.expectedLiveSha !== null && skill?.gitSha !== args.expectedLiveSha) {
    return { kind: "moved" };
  }
  if (skill && !skill.disabled && (await skillBlobsMatchAt(repo, name, skill.gitSha, target))) {
    return { kind: "unchanged", skill };
  }
  // Main already holds the target's files, as for a disabled skill rolled
  // back to its own version: no commit to make.
  const dir = skillDir(name);
  if (sameSkillBlobs(target, await skillBlobsUnder(repo.path, mainSha, dir))) {
    return { kind: "restore", sha: mainSha, mainAfter: mainSha };
  }

  const edits: TreeEdit[] = [
    ...(await pathsUnder(repo.path, mainSha, dir)).map(
      (path): TreeEdit => ({ kind: "remove", path }),
    ),
    ...[...target].map(([file, blob]): TreeEdit => ({ kind: "put", path: `${dir}${file}`, blob })),
  ];
  const tree = await writeEditedTree(repo.path, mainSha, edits);
  const sha = await commitAsCogmo(repo.path, {
    tree,
    parent: mainSha,
    subject: `revert(skills): roll ${name} back to ${restores.slice(0, 7)}`,
    trailers: { [RESTORES_TRAILER]: restores },
  });
  return { kind: "restore", sha, mainAfter: sha };
}
