import { err, ok, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import { classifyWithAst } from "../ast-classifier.js";
import { type LockfileSnapshot, parseLockfilePackageSpecs } from "../deps.js";
import { deleteRef, getMainSha, isAncestor, revParse } from "../git-ops.js";
import { checkPyodideCompat, formatPyodideCompatIssues } from "../pyodide-compat.js";
import type { ImportedSchemas } from "../schema-import.js";
import type { SkillsRepo } from "../skill-files.js";
import { formatSkillFinding, runSkillGates } from "../skill-gates.js";
import { readSkillSource, SKILL_BODY_FILE, SKILL_MANIFEST_FILE } from "../skill-source.js";
import type { ExecuteRegisterResult } from "../store/index.js";
import type { ClassifierLog, SkillManifest, SkillSchemas } from "../types.js";
import { describeWasmPackagesError, type SkillSchemaImportError } from "../worker-wasm/wasm.js";
import { advanceMain, runDeployTx } from "./advance-main.js";
import { checkRegisterBody, type RegisterBodyRejection } from "./check-register-body.js";
import { checkRegisterCpython, type RegisterCpythonRejection } from "./check-register-cpython.js";
import { type DeployDeps, requireRepo } from "./deploy-deps.js";
import { deployFacts } from "./deploy-facts.js";
import { describeLocateSkillRejection, locateSkill } from "./locate-skill.js";
import { type LockfileCheckError, readManifestLockfile } from "./lockfile-check.js";
import { mirrorMain } from "./mirror.js";
import { deployRunAs, type SkillDeployOrigin } from "./origin.js";
import { type RegisterPause, type RegisterResult, rejectedResult } from "./register-result.js";
import { registerSchemas } from "./schemas.js";

const NON_FAST_FORWARD = "non_fast_forward: rebase branch onto main and retry";

const log = logger.child({ component: "skills.runner" });

/** A sha that passed every check `register` makes before its transaction. */
interface PreparedRegister {
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
  const resolved = await resolveBranch(repoPath, opts.branch);
  if (resolved.isErr()) return resolved.error;
  const branchSha = resolved.value;
  const prepared = await prepareRegister(deps, repo, branchSha, opts.signal);
  // The last point an abort stops the deploy: the transaction moves main.
  // Checked ahead of the outcome, so an abort surfaces as itself, not as a
  // rejection it caused.
  opts.signal?.throwIfAborted();
  if (prepared.isErr()) return rejectionResult(branchSha, prepared.error);
  const { manifest, body, classifierLog, lockfile, schemas } = prepared.value;

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
 * The branch's tip. `main` itself is refused: register would "fast-forward"
 * main onto itself and then, after the commit, delete `refs/heads/main`, the
 * only authoritative ref. `deleteRef` refuses too; refusing here gives a
 * clear error before any git or DB work runs.
 */
async function resolveBranch(
  repoPath: string,
  branch: string,
): Promise<Result<string, RegisterResult>> {
  if (branch === "main" || branch === "refs/heads/main") {
    return err(rejectedResult("", "invalid_branch: cannot register from 'main' itself"));
  }
  const resolved = await revParse(repoPath, `refs/heads/${branch}`);
  return resolved.mapErr(() => rejectedResult("", `branch_not_found: ${branch}`));
}

/** A rejection that is terminal for the sha, its errors as `RegisterResult.errors` words them. */
interface Refused {
  kind: "refused";
  /** As `RegisterResult.name`: empty but on the schemas' rejections. */
  name: string;
  errors: readonly string[];
}

/** A check that could not run, which pauses the register. */
interface Paused {
  kind: "unavailable";
  cause: RegisterPause;
  /** As `RegisterResult.name`: empty but on the schemas' rejections. */
  name: string;
  /** As `RegisterResult.errors` words it. */
  error: string;
}

/** Why `prepareRegister` refuses a sha: terminal, pausing, or a sha `main` is not an ancestor of. */
type PrepareRejection = Refused | Paused | { kind: "stale_base"; mainSha: string };

function refused(...errors: readonly string[]): Refused {
  return { kind: "refused", name: "", errors };
}

function paused(cause: RegisterPause, error: string): Paused {
  return { kind: "unavailable", cause, name: "", error };
}

/** A rejection as `register` returns it. */
function rejectionResult(sha: string, rejection: PrepareRejection): RegisterResult {
  const rejected = (name: string, errors: readonly string[]): RegisterResult => ({
    name,
    riskTier: "notify",
    status: "rejected",
    gitSha: sha,
    errors,
  });
  return match(rejection)
    .with({ kind: "stale_base" }, () => rejected("", [NON_FAST_FORWARD]))
    .with({ kind: "refused" }, ({ name, errors }) => rejected(name, errors))
    .with({ kind: "unavailable" }, ({ name, error }) => rejected(name, [error]))
    .exhaustive();
}

/**
 * Every check `register` makes of a sha before its transaction: the
 * fast-forward, the skill it changes, its manifest and body, the
 * register-time gates and the classifier, the lockfile and its runtime pins,
 * Pyodide compatibility, the CPython checks, and the schemas it puts live.
 * It writes only what the checks' sessions and caches write. Errs with why it
 * refuses the sha.
 */
export async function prepareRegister(
  deps: DeployDeps,
  repo: SkillsRepo,
  sha: string,
  signal: AbortSignal | undefined,
): Promise<Result<PreparedRegister, PrepareRejection>> {
  const repoPath = repo.path;
  // Boot's layout commit gives main a sha before any register runs.
  const mainSha = await getMainSha(repoPath);
  if (mainSha === null) {
    throw new Error("register: the skills repo's main is unborn; boot makes the layout commit");
  }
  // Fast-forward check: the sha must descend from current main.
  if (!(await isAncestor(repoPath, mainSha, sha))) {
    return err({ kind: "stale_base", mainSha });
  }

  const located = await locateSkill(deps, repo, mainSha, sha);
  if (located.isErr()) {
    return err(refused(describeLocateSkillRejection(located.error)));
  }
  const name = located.value;

  const source = await readSkillSource(repo, name, sha);
  if (source.isErr()) {
    return err(
      match(source.error)
        .with({ kind: "missing_file", file: SKILL_MANIFEST_FILE }, () =>
          refused(`missing_skill_md: skills/${name}/SKILL.md not found at branch tip`),
        )
        .with({ kind: "missing_file", file: SKILL_BODY_FILE }, () =>
          refused(`missing_skill_py: skills/${name}/skill.py not found at branch tip`),
        )
        .with({ kind: "commit_not_found" }, () => refused("missing_commit: branch tip not found"))
        .with({ kind: "invalid_manifest" }, ({ issues }) => refused(...issues))
        .exhaustive(),
    );
  }
  const { manifest, body } = source.value;
  if (manifest.name !== name) {
    return err(
      refused(
        `skill_name_mismatch: skills/${name}/SKILL.md names the skill '${manifest.name}'; its directory must be skills/${manifest.name}/`,
      ),
    );
  }

  // The register-time gates, wasm-lint among them, then the classifier: no
  // body reaches the lockfile compile's sandbox session, or deploys, unless
  // the AST path read it (design/skills.md → Register-time gates).
  const checked = await checkRegisterBody(
    { runGates: runSkillGates, classify: classifyWithAst },
    { name, manifest, body },
    deps.capabilities,
  );
  if (checked.isErr()) return err(bodyRejection(checked.error));
  const classifierLog = checked.value;

  const lockfileResult = await readManifestLockfile(deps.lockfileCompiler, repo, sha, manifest, {
    verifyFresh: true,
    ...(signal && { signal }),
  });
  if (lockfileResult.isErr()) return err(lockfileRejection(lockfileResult.error));
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
    if (compat.isErr()) return err(refused(formatPyodideCompatIssues(compat.error)));
  }

  // Before the schema import, which mounts the venv the checks' install
  // session populated (design/skills.md → Register-time CPython checks).
  const cpython = await checkRegisterCpython(
    deps.cpythonChecks,
    { name, manifest, body, lockfile },
    { releaseVersion: deps.releaseVersion, signal },
  );
  if (cpython.isErr()) return err(cpythonRejection(cpython.error));

  const schemas = await resolveSchemas(deps, { manifest, body, lockfile, signal });
  if (schemas.isErr()) return err({ ...schemas.error, name: manifest.name });

  // Compile the JSON Schemas BEFORE any filesystem / DB write. Without this,
  // an invalid `inputs` / `outputs` schema would only surface at first invoke
  // — by which point `update-ref refs/heads/main` has already moved main +
  // the skills row is committed. Running ajv up-front makes "schema parses"
  // part of the deploy contract, alongside manifest YAML and effect
  // declarations.
  const schemaErrors = deps.sourceCache.prevalidate(schemas.value);
  if (schemaErrors.length > 0) {
    return err({ ...refused(...schemaErrors), name: manifest.name });
  }

  return ok({
    manifest,
    body,
    classifierLog: { ...classifierLog, ...cpython.value },
    lockfile,
    schemas: schemas.value,
  });
}

/** A body-check rejection: one string per gate finding, or the parser's pause. */
function bodyRejection(rejection: RegisterBodyRejection): PrepareRejection {
  return match(rejection)
    .returnType<PrepareRejection>()
    .with({ kind: "lint_failed" }, ({ findings }) => refused(...findings.map(formatSkillFinding)))
    .with({ kind: "classifier_rejected" }, ({ validationErrors }) =>
      refused(validationErrors.join("; ")),
    )
    .with({ kind: "registrar_unavailable" }, ({ cause, detail }) =>
      paused(
        "registrar_unavailable",
        `registrar_unavailable: ${cause}: ${detail}; retry the register`,
      ),
    )
    .exhaustive();
}

/** A CPython-check rejection: one string per finding, or the sandbox's pause. */
function cpythonRejection(rejection: RegisterCpythonRejection): PrepareRejection {
  return match(rejection)
    .returnType<PrepareRejection>()
    .with({ kind: "lint_failed" }, ({ findings }) => refused(...findings.map(formatSkillFinding)))
    .with({ kind: "lockfile_invalid" }, ({ detail }) =>
      refused(`requirements_lock_uninstallable: ${detail}`),
    )
    .with({ kind: "registrar_unavailable" }, ({ cause, detail }) =>
      paused(
        "registrar_unavailable",
        `registrar_unavailable: ${cause}: ${detail}; retry the register`,
      ),
    )
    .exhaustive();
}

/** A lockfile rejection: a compile that could not run pauses; every other kind is terminal. */
function lockfileRejection(error: LockfileCheckError): PrepareRejection {
  return match(error)
    .returnType<PrepareRejection>()
    .with({ kind: "transport_failed" }, ({ message }) => paused("lockfile_transport", message))
    .with({ kind: P.union("resolver_failed", "invalid") }, ({ message }) => refused(message))
    .exhaustive();
}

/**
 * The schemas register puts live. A wasm skill is imported in a child, which
 * fetches and publishes its packages on the way, so the first run pays no
 * download. A container skill is imported in a session created with no
 * network, mounting the venv register's install session populated, or takes
 * the legacy schema path, its frontmatter, where the deployment cannot
 * import it (design/skills.md → Contracts).
 */
async function resolveSchemas(
  deps: DeployDeps,
  args: {
    manifest: SkillManifest;
    body: string;
    lockfile: LockfileSnapshot | null;
    signal: AbortSignal | undefined;
  },
): Promise<Result<SkillSchemas, Refused | Paused>> {
  const { manifest } = args;
  const schemas = (imported: ImportedSchemas | null) =>
    registerSchemas(manifest, imported).mapErr((errors) => refused(...errors));
  return match(manifest.tier)
    .with("container", async () => {
      const importer = deps.containerSchemas;
      if (importer === undefined || (args.lockfile !== null && !importer.installsDependencies)) {
        return schemas(null);
      }
      const imported = await importer.importSchemas(
        { body: args.body, lockfile: args.lockfile, resources: manifest.resources },
        args.signal,
      );
      if (imported.isErr()) return err(schemaImportRejection(imported.error));
      return schemas(imported.value);
    })
    .with("wasm", async () => {
      const imported = await deps.wasm.importSchemas(
        { body: args.body, lockfile: args.lockfile, resources: manifest.resources },
        args.signal,
      );
      if (imported.isErr()) return err(schemaImportRejection(imported.error));
      return schemas(imported.value);
    })
    .exhaustive();
}

/**
 * A failed import as a rejection. A wheel that fails its hash, or has no pure
 * build, is a verdict on the lockfile; a network, cache or Pyodide-lockfile
 * failure is not, nor is a built-in whose cached or downloaded file fails
 * Pyodide's pinned sha256, and a retry may clear it: those pause.
 */
function schemaImportRejection(error: SkillSchemaImportError): Refused | Paused {
  return match(error)
    .returnType<Refused | Paused>()
    .with(
      { kind: "packages", error: { kind: P.union("hash_mismatch", "wheel_unavailable") } },
      (e) => refused(`wasm_dependency_unavailable: ${describeWasmPackagesError(e.error)}`),
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
        paused(
          "schema_import_unavailable",
          `schema_import_unavailable: the skill's packages were not fetched (${describeWasmPackagesError(e.error)}); retry the register`,
        ),
    )
    .with({ kind: "refused" }, (e) => refused(`schema_import_failed: ${e.message}`))
    .with({ kind: "unavailable" }, (e) =>
      paused(
        "schema_import_unavailable",
        `schema_import_unavailable: ${e.message}; retry the register`,
      ),
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
