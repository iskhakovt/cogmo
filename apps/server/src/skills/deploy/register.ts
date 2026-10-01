import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { classifyManifest } from "../classifier.js";
import { type LockfileSnapshot, parseLockfilePackageSpecs } from "../deps.js";
import { deleteRef, getMainSha, isAncestor, revParse, updateRef } from "../git-ops.js";
import { checkPyodideCompat, formatPyodideCompatIssues } from "../pyodide-compat.js";
import { readSkillSource, SKILL_BODY_FILE, SKILL_MANIFEST_FILE } from "../skill-source.js";
import type { ExecuteRegisterResult } from "../store/index.js";
import type { ClassifierLog, SkillManifest } from "../types.js";
import { lintWasmCompat } from "../worker-wasm/wasm-lint.js";
import { type DeployDeps, requireRepoPath, ZERO_SHA } from "./deploy-deps.js";
import { readManifestLockfile } from "./lockfile-check.js";
import { mirrorMainToRemote } from "./mirror.js";
import { deployRunAs, type SkillDeployOrigin } from "./origin.js";
import { type RegisterResult, rejectedResult } from "./register-result.js";

/** A branch that passed every check `register` makes before its transaction. */
interface PreparedRegister {
  branchSha: string;
  mainSha: string | null;
  manifest: SkillManifest;
  body: string;
  classifierLog: ClassifierLog;
  lockfile: LockfileSnapshot | null;
}

/**
 * Deploy a feature branch: check it, then advance main onto it (or queue it
 * for approval) in one transaction under the per-skill advisory lock, and
 * mirror main to the remote once it is live.
 */
export async function registerSkill(
  deps: DeployDeps,
  opts: { branch: string; origin: SkillDeployOrigin; signal?: AbortSignal },
): Promise<RegisterResult> {
  const repoPath = requireRepoPath(deps, "register");

  opts.signal?.throwIfAborted();
  const prepared = await prepareRegister(deps, repoPath, opts.branch, opts.signal);
  // The last point an abort stops the deploy: the transaction moves main.
  // Checked ahead of the outcome, so an abort surfaces as itself, not as a
  // rejection it caused.
  opts.signal?.throwIfAborted();
  if (prepared.isErr()) return prepared.error;
  const { branchSha, mainSha, manifest, body, classifierLog, lockfile } = prepared.value;

  const schedule = manifest.schedule ?? null;
  const result = await deps.runInTx((tx) =>
    deps.store.executeRegister(tx, {
      name: manifest.name,
      tier: manifest.tier,
      riskTier: classifierLog.risk_tier,
      effects: manifest.effects,
      schedule,
      scheduleNextRunAt: deps.scheduleNextRunAt(schedule),
      branchTipSha: branchSha,
      lockfileHash: lockfile?.hash ?? null,
      inputs: manifest.inputs,
      outputs: manifest.outputs ?? null,
      classifierLog,
      runAs: deployRunAs(deps.defaultRunAs, opts.origin),
      applyFilesystem: async () => {
        await updateRef(repoPath, "refs/heads/main", branchSha, mainSha ?? ZERO_SHA);
        await deleteRef(repoPath, `refs/heads/${opts.branch}`);
      },
    }),
  );

  // Mirror the new main SHA to the configured remote so a Daytona-backed
  // coding task cloning from origin sees the just-registered skill. Best-
  // effort — local state is authoritative.
  if (result.kind === "live") {
    await mirrorMainToRemote(deps, repoPath, branchSha, {
      ...(opts.signal && { signal: opts.signal }),
    });
  }

  return registerResultToRpc(deps, {
    name: manifest.name,
    branchSha,
    classifierLog,
    result,
    manifest,
    body,
    lockfile,
  });
}

/**
 * Every check `register` makes before its transaction: the branch, its
 * manifest and body, the classifier, the lockfile, Pyodide compatibility.
 * Errs with the rejection `register` returns.
 */
async function prepareRegister(
  deps: DeployDeps,
  repoPath: string,
  branch: string,
  signal: AbortSignal | undefined,
): Promise<Result<PreparedRegister, RegisterResult>> {
  // Reject branch=main at the boundary. Without this guard, the register
  // flow would (a) "fast-forward" main onto itself (no-op) and then
  // (b) call `deleteRef("refs/heads/main")` in the same applyFilesystem
  // step, which would drop the only authoritative ref. The deleteRef
  // helper refuses too (defense in depth), but rejecting at the entry
  // gives a clear error before any git/DB work runs.
  if (branch === "main" || branch === "refs/heads/main") {
    return err(rejectedResult("", "invalid_branch: cannot register from 'main' itself"));
  }

  const resolved = await revParse(repoPath, `refs/heads/${branch}`);
  if (resolved.isErr()) {
    return err(rejectedResult("", `branch_not_found: ${branch}`));
  }
  const branchSha = resolved.value;

  const mainSha = await getMainSha(repoPath);
  // Fast-forward check: feature branch must descend from current main.
  if (mainSha && !(await isAncestor(repoPath, mainSha, branchSha))) {
    return err(rejectedResult(branchSha, "non_fast_forward: rebase branch onto main and retry"));
  }

  const source = await readSkillSource(repoPath, branchSha);
  if (source.isErr()) {
    return err(
      match(source.error)
        .with({ kind: "missing_file", file: SKILL_MANIFEST_FILE }, () =>
          rejectedResult(branchSha, "missing_skill_md: SKILL.md not found at branch tip"),
        )
        .with({ kind: "missing_file", file: SKILL_BODY_FILE }, () =>
          rejectedResult(branchSha, "missing_skill_py: skill.py not found at branch tip"),
        )
        .with({ kind: "commit_not_found" }, () =>
          rejectedResult(branchSha, "missing_commit: branch tip not found"),
        )
        .with({ kind: "invalid_manifest" }, ({ issues }) => rejectedResult(branchSha, ...issues))
        .exhaustive(),
    );
  }
  const { manifest, body } = source.value;

  // Compile the manifest's JSON Schemas BEFORE any filesystem / DB write.
  // Without this, an invalid `inputs` / `outputs` schema would only surface
  // at first invoke — by which point `update-ref refs/heads/main` has
  // already moved main + the skills row is committed. Running ajv up-front
  // makes "schema parses" part of the deploy contract, alongside manifest
  // YAML and effect declarations.
  const schemaErrors = deps.sourceCache.prevalidate(manifest);
  if (schemaErrors.length > 0) {
    return err({
      name: manifest.name,
      riskTier: "notify",
      status: "rejected",
      gitSha: branchSha,
      errors: schemaErrors,
    });
  }

  // Tier-1 bodies get the Pyodide-compatibility scan before anything is
  // written. Its whole purpose is turning "imports fine, dies on first
  // invoke" into a rejection here, which only holds if it actually runs
  // on the register path.
  if (manifest.tier === "wasm") {
    const lint = lintWasmCompat(body);
    if (lint.isErr()) {
      return err(
        rejectedResult(branchSha, lint.error.map((e) => `line ${e.line}: ${e.reason}`).join("; ")),
      );
    }
  }

  const classifierLog = await classifyManifest(manifest, body);
  if (classifierLog.validation_errors.length > 0) {
    // Undeclared dangerous effects → reject the deploy outright with
    // the per-effect labels surfaced to the user. Don't even insert
    // a `denied` deploy row: the AST path is a pre-flight, not a
    // human approval, and storing a denied row for "manifest typo"
    // pollutes the audit log meant for real approval-gate events.
    return err(rejectedResult(branchSha, classifierLog.validation_errors.join("; ")));
  }

  const lockfileResult = await readManifestLockfile(
    deps.lockfileCompiler,
    repoPath,
    branchSha,
    manifest,
    { verifyFresh: true, ...(signal && { signal }) },
  );
  if (lockfileResult.isErr()) {
    return err(rejectedResult(branchSha, lockfileResult.error));
  }
  const lockfile = lockfileResult.value;

  if (manifest.tier === "wasm" && lockfile !== null) {
    const compat = await checkPyodideCompat(parseLockfilePackageSpecs(lockfile.contents));
    if (compat.isErr()) {
      return err(rejectedResult(branchSha, formatPyodideCompatIssues(compat.error)));
    }
  }

  return ok({ branchSha, mainSha, manifest, body, classifierLog, lockfile });
}

function registerResultToRpc(
  deps: Pick<DeployDeps, "sourceCache">,
  args: {
    name: string;
    branchSha: string;
    classifierLog: ClassifierLog;
    result: ExecuteRegisterResult;
    manifest: SkillManifest;
    body: string;
    lockfile: LockfileSnapshot | null;
  },
): RegisterResult {
  const { name, branchSha, classifierLog, result, manifest, body, lockfile } = args;
  if (result.kind === "rejected") {
    return rejectedResult(branchSha, result.reason);
  }
  if (result.kind === "no_op") {
    return {
      name,
      riskTier: result.skill.riskTier,
      status: "no_op",
      gitSha: result.skill.gitSha,
    };
  }
  if (result.kind === "live") {
    // Warm the source cache with the just-registered manifest+body so the
    // next `invoke` (or tool-list rebuild) doesn't re-read git.
    deps.sourceCache.put(branchSha, { manifest, body }, lockfile);
    return {
      name,
      riskTier: classifierLog.risk_tier,
      status: "live",
      gitSha: result.skill.gitSha,
    };
  }
  // pending_approval — also warm cache so a follow-up approve doesn't re-read.
  deps.sourceCache.put(branchSha, { manifest, body }, lockfile);
  return {
    name,
    riskTier: classifierLog.risk_tier,
    status: "pending_approval",
    gitSha: branchSha,
    pendingId: result.deploy.id,
    ...(manifest.schedule !== undefined && { schedule: manifest.schedule }),
  };
}
