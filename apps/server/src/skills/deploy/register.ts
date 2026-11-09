import { err, ok, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import { classifyManifest } from "../classifier.js";
import { type LockfileSnapshot, parseLockfilePackageSpecs } from "../deps.js";
import { deleteRef, getMainSha, isAncestor, revParse } from "../git-ops.js";
import { checkPyodideCompat, formatPyodideCompatIssues } from "../pyodide-compat.js";
import type { SkillsRepo } from "../skill-files.js";
import { readSkillSource, SKILL_BODY_FILE, SKILL_MANIFEST_FILE } from "../skill-source.js";
import type { ExecuteRegisterResult } from "../store/index.js";
import type { ClassifierLog, SkillManifest, SkillSchemas } from "../types.js";
import { describeWasmPackagesError, type SkillSchemaImportError } from "../worker-wasm/wasm.js";
import { lintWasmCompat } from "../worker-wasm/wasm-lint.js";
import { advanceMain, runDeployTx } from "./advance-main.js";
import { type DeployDeps, requireRepo } from "./deploy-deps.js";
import { deployFacts } from "./deploy-facts.js";
import { describeLocateSkillRejection, locateSkill } from "./locate-skill.js";
import { readManifestLockfile } from "./lockfile-check.js";
import { mirrorMain } from "./mirror.js";
import { deployRunAs, type SkillDeployOrigin } from "./origin.js";
import { type RegisterResult, rejectedResult } from "./register-result.js";
import { registerSchemas } from "./schemas.js";

const NON_FAST_FORWARD = "non_fast_forward: rebase branch onto main and retry";

const log = logger.child({ component: "skills.runner" });

/** A branch that passed every check `register` makes before its transaction. */
interface PreparedRegister {
  branchSha: string;
  manifest: SkillManifest;
  body: string;
  classifierLog: ClassifierLog;
  lockfile: LockfileSnapshot | null;
  schemas: SkillSchemas;
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
  const repo = requireRepo(deps, "register");
  const repoPath = repo.path;

  opts.signal?.throwIfAborted();
  const prepared = await prepareRegister(deps, repo, opts.branch, opts.signal);
  // The last point an abort stops the deploy: the transaction moves main.
  // Checked ahead of the outcome, so an abort surfaces as itself, not as a
  // rejection it caused.
  opts.signal?.throwIfAborted();
  if (prepared.isErr()) return prepared.error;
  const { branchSha, manifest, body, classifierLog, lockfile, schemas } = prepared.value;

  const schedule = manifest.schedule ?? null;
  const executed = await runDeployTx(deps.runInTx, (tx) =>
    deps.store.executeRegister(tx, {
      name: manifest.name,
      tier: manifest.tier,
      riskTier: classifierLog.risk_tier,
      effects: manifest.effects,
      schedule,
      scheduleNextRunAt: deps.scheduleNextRunAt(schedule),
      branchTipSha: branchSha,
      lockfileHash: lockfile?.hash ?? null,
      inputs: schemas.inputs,
      outputs: schemas.outputs,
      classifierLog,
      runAs: deployRunAs(deps.defaultRunAs, opts.origin),
      applyFilesystem: async () => {
        await deps.store.markMainAdvanced(tx, branchSha);
        await advanceMain(repoPath, branchSha, { kind: "fast_forward" });
      },
    }),
  );
  // `main_moved`: a deploy of another skill moved main off the branch's base.
  if (executed.isErr()) return rejectedResult(branchSha, NON_FAST_FORWARD);
  const result = executed.value;

  if (result.kind === "live") {
    // Both after the commit and best-effort: local state is authoritative.
    // The branch goes once the deploy is committed, so a register repeated
    // after a failed commit still has a branch to register; one left behind
    // re-registers as `no_op` while its tip is main, and as non-fast-forward
    // once another skill has deployed. The mirror lets a Daytona-backed
    // coding task cloning from origin see the just-registered skill.
    await deleteFeatureBranch(repoPath, opts.branch);
    await mirrorMain(deps, repoPath, branchSha, {
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
    schemas,
  });
}

async function deleteFeatureBranch(repoPath: string, branch: string): Promise<void> {
  try {
    await deleteRef(repoPath, `refs/heads/${branch}`);
  } catch (e) {
    log.warn(
      { branch, error: describeError(e) },
      "skills feature branch not deleted after register; main is authoritative",
    );
  }
}

/**
 * Every check `register` makes before its transaction: the branch, its
 * manifest and body, the classifier, the lockfile and its runtime pins,
 * Pyodide compatibility, and the schemas it puts live.
 * Errs with the rejection `register` returns.
 */
async function prepareRegister(
  deps: DeployDeps,
  repo: SkillsRepo,
  branch: string,
  signal: AbortSignal | undefined,
): Promise<Result<PreparedRegister, RegisterResult>> {
  const repoPath = repo.path;
  // Reject branch=main at the boundary. Without this guard, the register
  // flow would "fast-forward" main onto itself (no-op) and then, after the
  // commit, call `deleteRef("refs/heads/main")`, which would drop the only
  // authoritative ref. The deleteRef helper refuses too (defense in depth),
  // but rejecting at the entry gives a clear error before any git/DB work
  // runs.
  if (branch === "main" || branch === "refs/heads/main") {
    return err(rejectedResult("", "invalid_branch: cannot register from 'main' itself"));
  }

  const resolved = await revParse(repoPath, `refs/heads/${branch}`);
  if (resolved.isErr()) {
    return err(rejectedResult("", `branch_not_found: ${branch}`));
  }
  const branchSha = resolved.value;

  // Boot's layout commit gives main a sha before any register runs.
  const mainSha = await getMainSha(repoPath);
  if (mainSha === null) {
    throw new Error("register: the skills repo's main is unborn; boot makes the layout commit");
  }
  // Fast-forward check: feature branch must descend from current main.
  if (!(await isAncestor(repoPath, mainSha, branchSha))) {
    return err(rejectedResult(branchSha, NON_FAST_FORWARD));
  }

  const located = await locateSkill(deps, repo, mainSha, branchSha);
  if (located.isErr()) {
    return err(rejectedResult(branchSha, describeLocateSkillRejection(located.error)));
  }
  const name = located.value;

  const source = await readSkillSource(repo, name, branchSha);
  if (source.isErr()) {
    return err(
      match(source.error)
        .with({ kind: "missing_file", file: SKILL_MANIFEST_FILE }, () =>
          rejectedResult(
            branchSha,
            `missing_skill_md: skills/${name}/SKILL.md not found at branch tip`,
          ),
        )
        .with({ kind: "missing_file", file: SKILL_BODY_FILE }, () =>
          rejectedResult(
            branchSha,
            `missing_skill_py: skills/${name}/skill.py not found at branch tip`,
          ),
        )
        .with({ kind: "commit_not_found" }, () =>
          rejectedResult(branchSha, "missing_commit: branch tip not found"),
        )
        .with({ kind: "invalid_manifest" }, ({ issues }) => rejectedResult(branchSha, ...issues))
        .exhaustive(),
    );
  }
  const { manifest, body } = source.value;
  if (manifest.name !== name) {
    return err(
      rejectedResult(
        branchSha,
        `skill_name_mismatch: skills/${name}/SKILL.md names the skill '${manifest.name}'; its directory must be skills/${manifest.name}/`,
      ),
    );
  }

  // Wasm bodies get the Pyodide-compatibility scan before anything is
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

  const classifierLog = await classifyManifest(manifest, body, deps.capabilities);
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
    repo,
    branchSha,
    manifest,
    { verifyFresh: true, ...(signal && { signal }) },
  );
  if (lockfileResult.isErr()) {
    return err(rejectedResult(branchSha, lockfileResult.error));
  }
  const lockfile = lockfileResult.value;

  if (manifest.tier === "wasm" && lockfile !== null) {
    const compat = await checkPyodideCompat(parseLockfilePackageSpecs(lockfile.contents), {
      fetchImpl: deps.wasm.fetchImpl,
      probe: {
        probe: deps.wasm.probe,
        fillBuiltins: deps.wasm.fillBuiltins,
        packageCacheDir: deps.wasm.packageCacheDir,
        ...(signal && { signal }),
      },
    });
    if (compat.isErr()) {
      return err(rejectedResult(branchSha, formatPyodideCompatIssues(compat.error)));
    }
  }

  const schemas = await resolveSchemas(deps, { manifest, body, lockfile, signal });
  if (schemas.isErr()) {
    return err({
      name: manifest.name,
      riskTier: "notify",
      status: "rejected",
      gitSha: branchSha,
      errors: schemas.error,
    });
  }

  // Compile the JSON Schemas BEFORE any filesystem / DB write. Without this,
  // an invalid `inputs` / `outputs` schema would only surface at first invoke
  // — by which point `update-ref refs/heads/main` has already moved main +
  // the skills row is committed. Running ajv up-front makes "schema parses"
  // part of the deploy contract, alongside manifest YAML and effect
  // declarations.
  const schemaErrors = deps.sourceCache.prevalidate(schemas.value);
  if (schemaErrors.length > 0) {
    return err({
      name: manifest.name,
      riskTier: "notify",
      status: "rejected",
      gitSha: branchSha,
      errors: schemaErrors,
    });
  }

  return ok({ branchSha, manifest, body, classifierLog, lockfile, schemas: schemas.value });
}

/**
 * The schemas register puts live. A wasm skill is imported in a child, which
 * fetches and publishes its packages on the way, so the first run pays no
 * download. A container skill is imported in a session created with no
 * network, after an install session for its dependencies, or takes the
 * legacy schema path, its frontmatter, where the deployment cannot import it
 * (design/skills.md → Contracts).
 */
async function resolveSchemas(
  deps: DeployDeps,
  args: {
    manifest: SkillManifest;
    body: string;
    lockfile: LockfileSnapshot | null;
    signal: AbortSignal | undefined;
  },
): Promise<Result<SkillSchemas, string[]>> {
  const { manifest } = args;
  return match(manifest.tier)
    .with("container", async () => {
      const importer = deps.containerSchemas;
      if (importer === undefined || (args.lockfile !== null && !importer.installsDependencies)) {
        return registerSchemas(manifest, null);
      }
      const imported = await importer.importSchemas(
        { body: args.body, lockfile: args.lockfile, resources: manifest.resources },
        args.signal,
      );
      if (imported.isErr()) return err([describeSchemaImportError(imported.error)]);
      return registerSchemas(manifest, imported.value);
    })
    .with("wasm", async () => {
      const imported = await deps.wasm.importSchemas(
        { body: args.body, lockfile: args.lockfile, resources: manifest.resources },
        args.signal,
      );
      if (imported.isErr()) return err([describeSchemaImportError(imported.error)]);
      return registerSchemas(manifest, imported.value);
    })
    .exhaustive();
}

/**
 * A failed import as a rejection. A wheel that fails its hash, or has no pure
 * build, is a verdict on the lockfile; a network, cache or Pyodide-lockfile
 * failure is not, nor is a built-in whose cached or downloaded file fails
 * Pyodide's pinned sha256, and a retry may clear it.
 */
function describeSchemaImportError(error: SkillSchemaImportError): string {
  return match(error)
    .with(
      { kind: "packages", error: { kind: P.union("hash_mismatch", "wheel_unavailable") } },
      (e) => `wasm_dependency_unavailable: ${describeWasmPackagesError(e.error)}`,
    )
    .with(
      {
        kind: "packages",
        error: {
          kind: P.union(
            "network_failed",
            "prefetch_failed",
            "publish_failed",
            "bundled_unreadable",
            "builtin_integrity",
          ),
        },
      },
      (e) =>
        `schema_import_unavailable: the skill's packages were not fetched (${describeWasmPackagesError(e.error)}); retry the register`,
    )
    .with({ kind: "refused" }, (e) => `schema_import_failed: ${e.message}`)
    .with(
      { kind: "unavailable" },
      (e) => `schema_import_unavailable: ${e.message}; retry the register`,
    )
    .exhaustive();
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
    schemas: SkillSchemas;
  },
): RegisterResult {
  const { name, branchSha, classifierLog, result, manifest, body, lockfile, schemas } = args;
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
    deps.sourceCache.put(branchSha, { manifest, body }, schemas, lockfile);
    return {
      name,
      riskTier: classifierLog.risk_tier,
      status: "live",
      gitSha: result.skill.gitSha,
      skillId: result.skill.id,
      deployId: result.deploy.id,
      facts: deployFacts(manifest, result.deploy),
    };
  }
  // pending_approval — also warm cache so a follow-up approve doesn't re-read.
  deps.sourceCache.put(branchSha, { manifest, body }, schemas, lockfile);
  return {
    name,
    riskTier: classifierLog.risk_tier,
    status: "pending_approval",
    gitSha: branchSha,
    skillId: result.skill.id,
    deployId: result.deploy.id,
    facts: deployFacts(manifest, result.deploy),
  };
}
