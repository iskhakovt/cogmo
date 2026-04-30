import { Ajv, type ValidateFunction } from "ajv";
import { logger } from "../logger.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { classifyManifest, STUB_CLASSIFIER_VERSION } from "./classifier.js";
import { type CtxUser, DefaultCtxHandler } from "./ctx-handler.js";
import {
  deleteRef,
  GitOpsError,
  getMainSha,
  gitShow,
  isAncestor,
  revParse,
  updateRef,
} from "./git-ops.js";
import { parseManifest } from "./manifest.js";
import type {
  ExecuteRegisterResult,
  InsertSkillParams,
  SkillRiskTier,
  SkillRow,
  SkillRunTrigger,
  SkillStore,
  SkillTier,
} from "./store/index.js";
import type { ClassifierLog, SkillIo, SkillManifest } from "./types.js";
import { runOnWorker } from "./worker-wasm/host.js";

const log = logger.child({ component: "skills.runner" });

const ZERO_SHA = "0000000000000000000000000000000000000000";

const STUB_CLASSIFIER_LOG: ClassifierLog = {
  classifier_version: STUB_CLASSIFIER_VERSION,
  risk_tier: "auto",
  declared_effects: [],
  detected_effects: [],
  declared_secrets: [],
  validation_errors: [],
};

export interface RegisterResult {
  name: string;
  riskTier: SkillRiskTier;
  status: "live" | "pending_approval" | "rejected" | "no_op";
  gitSha: string;
  errors?: readonly string[];
  pendingId?: string;
}

export interface SkillRunResult {
  runId: string;
  status: "success" | "error";
  output?: unknown;
  error?: string;
}

export interface SkillSummary {
  name: string;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  disabled: boolean;
  gitSha: string;
}

/**
 * The full per-skill descriptor needed to register the skill as an LLM tool.
 * Returned by {@link SkillRunner.listToolDefs} so the orchestrator can rebuild
 * the per-turn tool list without re-reading git for each entry.
 */
export interface SkillToolDef {
  name: string;
  /**
   * From `SKILL.md` frontmatter. The first line of the body is appended when
   * present so the LLM-facing description picks up the human-readable
   * preamble too. Bounded ≤500 chars (manifest validator already caps).
   */
  description: string;
  /** JSON Schema as declared in the manifest. Forwarded directly to the LLM. */
  inputs: SkillIo;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  gitSha: string;
}

/**
 * Public contract for the skills runtime. P3.3 fills in the deployment-pipeline
 * RPCs (`register` / `approveDeploy` / `denyDeploy` / `rollback` / `deregister`)
 * around the P3.1 invocation loop. The interface is the boundary the CLI, agent
 * tool, and dynamic-tool registrar all depend on.
 */
export interface SkillRunner {
  register(opts: { branch: string }): Promise<RegisterResult>;
  approveDeploy(opts: { pendingId: string; approvedBy?: string }): Promise<RegisterResult>;
  denyDeploy(opts: { pendingId: string; reason?: string }): Promise<void>;
  rollback(opts: { name: string; toGitSha: string }): Promise<RegisterResult>;
  deregister(opts: { name: string }): Promise<void>;

  list(): Promise<readonly SkillSummary[]>;
  /**
   * Like {@link list} but loads the per-skill manifest from git so each entry
   * carries the description + input JSON Schema needed for LLM tool
   * registration. One filesystem read per skill, deduped by `(name, gitSha)`
   * via the runner's internal source cache — turn-N rebuild reuses turn-(N-1)
   * cache entries when SHAs match.
   */
  listToolDefs(): Promise<readonly SkillToolDef[]>;
  invoke(opts: {
    name: string;
    inputs: unknown;
    trigger?: SkillRunTrigger;
  }): Promise<SkillRunResult>;
}

/**
 * P3.1 test seeding helper. Inserts a skills row + live skill_deploys row from
 * a directly-handed manifest+body, populating the source cache so `invoke()`
 * can find it without going through git. Used by store-level tests where
 * spinning up a real bare repo would be overkill.
 *
 * The real `register` RPC (now implemented) is the production path; tests
 * touching the deploy pipeline use that, not this.
 */
export interface RegisterForTestsParams {
  name: string;
  manifestSource: string;
  body: string;
  /** Optional fake commit sha — defaults to a deterministic hash of the body. */
  gitSha?: string;
}

export interface SkillRunnerOptions {
  store: SkillStore;
  secretsStore: SecretsStore;
  memory: MemoryProvider;
  user: CtxUser;
  /** Memory bank id passed to ctx.memory.* — typically the user's bank. */
  memoryBankId: string;
  /**
   * Path to the bare skills repo (`$COGMO_SKILLS_PATH`). Required for the
   * register / rollback flows that read SKILL.md from git and advance
   * `refs/heads/main` via `git update-ref`. Tests that only exercise
   * `__registerForTests` + `invoke` may omit this; calling `register` /
   * `rollback` without it throws a clear error.
   */
  skillsRepoPath?: string;
  /** Pyodide package cache directory — speeds up cold starts. Optional. */
  pyodidePackageCacheDir?: string;
}

interface SkillSourceCacheEntry {
  manifest: SkillManifest;
  body: string;
  inputsValidator: ValidateFunction;
}

export class SkillRunnerImpl implements SkillRunner {
  #store: SkillStore;
  #secretsStore: SecretsStore;
  #memory: MemoryProvider;
  #user: CtxUser;
  #memoryBankId: string;
  #skillsRepoPath: string | undefined;
  #pyodidePackageCacheDir: string | undefined;
  #ajv: Ajv;
  /**
   * Parsed manifest + compiled validator cache, keyed by `<name>@<sha>`. A new
   * deploy invalidates by virtue of the new SHA being in the key — no manual
   * eviction needed. `__registerForTests` writes via the same cache keyed by
   * the stub SHA it generated, so test invocations don't re-read.
   */
  #sourceCache = new Map<string, SkillSourceCacheEntry>();

  private constructor(opts: SkillRunnerOptions) {
    this.#store = opts.store;
    this.#secretsStore = opts.secretsStore;
    this.#memory = opts.memory;
    this.#user = opts.user;
    this.#memoryBankId = opts.memoryBankId;
    this.#skillsRepoPath = opts.skillsRepoPath;
    this.#pyodidePackageCacheDir = opts.pyodidePackageCacheDir;
    this.#ajv = new Ajv({ allErrors: true, strict: false });
  }

  static async create(opts: SkillRunnerOptions): Promise<SkillRunnerImpl> {
    return new SkillRunnerImpl(opts);
  }

  // --- Deployment pipeline ---

  async register(opts: { branch: string }): Promise<RegisterResult> {
    const repoPath = this.#requireRepoPath("register");

    // Reject branch=main at the boundary. Without this guard, the register
    // flow would (a) "fast-forward" main onto itself (no-op) and then
    // (b) call `deleteRef("refs/heads/main")` in the same applyFilesystem
    // step, which would drop the only authoritative ref. The deleteRef
    // helper now refuses too (defense in depth), but rejecting at the entry
    // gives a clear error before any git/DB work runs.
    if (opts.branch === "main" || opts.branch === "refs/heads/main") {
      return rejectedResult("", "invalid_branch: cannot register from 'main' itself");
    }

    let branchSha: string;
    try {
      branchSha = await revParse(repoPath, `refs/heads/${opts.branch}`);
    } catch (e) {
      if (e instanceof GitOpsError && e.code === "ref_not_found") {
        return rejectedResult("", `branch_not_found: ${opts.branch}`);
      }
      throw e;
    }

    const mainSha = await getMainSha(repoPath);
    // Fast-forward check: feature branch must descend from current main.
    if (mainSha && !(await isAncestor(repoPath, mainSha, branchSha))) {
      return rejectedResult(branchSha, "non_fast_forward: rebase branch onto main and retry");
    }

    let manifestSource: string;
    let body: string;
    try {
      manifestSource = await gitShow(repoPath, branchSha, "SKILL.md");
    } catch (e) {
      if (e instanceof GitOpsError && e.code === "file_not_found") {
        return rejectedResult(branchSha, "missing_skill_md: SKILL.md not found at branch tip");
      }
      throw e;
    }
    try {
      body = await gitShow(repoPath, branchSha, "skill.py");
    } catch (e) {
      if (e instanceof GitOpsError && e.code === "file_not_found") {
        return rejectedResult(branchSha, "missing_skill_py: skill.py not found at branch tip");
      }
      throw e;
    }

    const parsed = parseManifest(manifestSource);
    if (!parsed.isOk()) {
      const errors =
        parsed.error.kind === "invalid_manifest" ? parsed.error.issues : [parsed.error.message];
      return {
        name: "",
        riskTier: "notify",
        status: "rejected",
        gitSha: branchSha,
        errors,
      };
    }
    const manifest = parsed.value.manifest;

    // Compile the manifest's JSON Schemas BEFORE any filesystem / DB write.
    // Without this, an invalid `inputs` / `outputs` schema would only surface
    // at first invoke — by which point `update-ref refs/heads/main` has
    // already moved main + the skills row is committed. Running ajv up-front
    // makes "schema parses" part of the deploy contract, alongside manifest
    // YAML and effect declarations.
    const schemaErrors = this.#prevalidateSchemas(manifest);
    if (schemaErrors.length > 0) {
      return {
        name: manifest.name,
        riskTier: "notify",
        status: "rejected",
        gitSha: branchSha,
        errors: schemaErrors,
      };
    }

    const classifierLog = classifyManifest(manifest);

    const result = await this.#store.executeRegister({
      name: manifest.name,
      tier: manifest.tier,
      riskTier: classifierLog.risk_tier,
      effects: manifest.effects,
      schedule: manifest.schedule ?? null,
      branchTipSha: branchSha,
      inputs: manifest.inputs,
      outputs: manifest.outputs ?? null,
      classifierLog,
      applyFilesystem: async () => {
        await updateRef(repoPath, "refs/heads/main", branchSha, mainSha ?? ZERO_SHA);
        await deleteRef(repoPath, `refs/heads/${opts.branch}`);
      },
    });

    return this.#registerResultToRpc({
      name: manifest.name,
      branchSha,
      classifierLog,
      result,
      manifest,
      body,
    });
  }

  async approveDeploy(opts: { pendingId: string; approvedBy?: string }): Promise<RegisterResult> {
    const repoPath = this.#requireRepoPath("approveDeploy");

    const deploy = await this.#store.getDeployById(opts.pendingId);
    if (!deploy) {
      return rejectedResult("", `deploy_not_found: ${opts.pendingId}`);
    }
    if (deploy.status !== "pending_approval") {
      return rejectedResult(deploy.gitSha, `deploy_not_pending: status is '${deploy.status}'`);
    }

    const skill = await this.#store.getSkillById(deploy.skillId);
    if (!skill) {
      return rejectedResult(deploy.gitSha, "skill_not_found");
    }

    const mainSha = await getMainSha(repoPath);
    // Fast-forward check at approve time too — main may have moved since the
    // approve-tier deploy was created.
    if (mainSha && !(await isAncestor(repoPath, mainSha, deploy.gitSha))) {
      return rejectedResult(deploy.gitSha, "non_fast_forward_at_approve_time");
    }

    // Re-read the manifest at deploy.gitSha so executeApprove can write the
    // full set of manifest-derived columns (tier/effects/inputs/outputs/etc.)
    // alongside gitSha. Without this projection the row would still reflect
    // the prior live commit's manifest while pointing at the approved sha,
    // which would silently mismatch tool definitions and ajv input
    // validation against the actual code on disk.
    let manifest: SkillManifest;
    let body: string;
    try {
      const manifestSource = await gitShow(repoPath, deploy.gitSha, "SKILL.md");
      body = await gitShow(repoPath, deploy.gitSha, "skill.py");
      const parsed = parseManifest(manifestSource);
      if (!parsed.isOk()) {
        return rejectedResult(
          deploy.gitSha,
          `target_manifest_invalid: ${
            parsed.error.kind === "invalid_manifest"
              ? parsed.error.issues.join("; ")
              : parsed.error.message
          }`,
        );
      }
      manifest = parsed.value.manifest;
    } catch (e) {
      if (e instanceof GitOpsError && e.code === "file_not_found") {
        return rejectedResult(deploy.gitSha, "target_missing_source");
      }
      throw e;
    }

    if (manifest.name !== skill.name) {
      return rejectedResult(
        deploy.gitSha,
        `target_skill_mismatch: deploy sha belongs to skill '${manifest.name}', not '${skill.name}'`,
      );
    }

    const schemaErrors = this.#prevalidateSchemas(manifest);
    if (schemaErrors.length > 0) {
      return {
        name: skill.name,
        riskTier: deploy.riskTier,
        status: "rejected",
        gitSha: deploy.gitSha,
        errors: schemaErrors,
      };
    }

    const result = await this.#store.executeApprove({
      pendingId: opts.pendingId,
      approvedBy: opts.approvedBy ?? null,
      tier: manifest.tier,
      // Preserve the deploy row's classified tier (which is what the user
      // approved). Re-classifying here could promote an `approve` deploy to a
      // different tier mid-flow, which would be confusing.
      riskTier: deploy.riskTier,
      effects: manifest.effects,
      schedule: manifest.schedule ?? null,
      inputs: manifest.inputs,
      outputs: manifest.outputs ?? null,
      applyFilesystem: async () => {
        await updateRef(repoPath, "refs/heads/main", deploy.gitSha, mainSha ?? ZERO_SHA);
      },
    });

    if (result.kind === "live") {
      // Warm the source cache with the just-approved manifest so the next
      // listToolDefs / invoke read doesn't re-fetch from git.
      const inputsValidator = this.#compileInputsValidator(manifest, "approve-warm");
      this.#sourceCache.set(cacheKey(skill.name, deploy.gitSha), {
        manifest,
        body,
        inputsValidator,
      });
      return {
        name: result.skill.name,
        riskTier: result.skill.riskTier,
        status: "live",
        gitSha: result.skill.gitSha,
      };
    }
    return rejectedResult(deploy.gitSha, result.kind === "rejected" ? result.reason : result.kind);
  }

  async denyDeploy(opts: { pendingId: string; reason?: string }): Promise<void> {
    await this.#store.denyPendingDeploy({
      pendingId: opts.pendingId,
      reason: opts.reason ?? null,
    });
  }

  async rollback(opts: { name: string; toGitSha: string }): Promise<RegisterResult> {
    const repoPath = this.#requireRepoPath("rollback");

    let targetSha: string;
    try {
      targetSha = await revParse(repoPath, opts.toGitSha);
    } catch (e) {
      if (e instanceof GitOpsError && e.code === "ref_not_found") {
        return rejectedResult(opts.toGitSha, `target_sha_not_found: ${opts.toGitSha}`);
      }
      throw e;
    }

    // Re-read the manifest at the target sha. We need it for two things:
    // (a) verify manifest.name matches opts.name — without this, rolling
    // back skill X to a sha that originally belonged to skill Y would
    // silently rebind X to Y's code; (b) project the full set of
    // manifest-derived columns (tier, effects, schedule, inputs, outputs,
    // riskTier) into the skills row, so tool definitions and validation
    // reflect what's actually on disk at the rolled-back sha.
    let manifest: SkillManifest;
    let body: string;
    try {
      const manifestSource = await gitShow(repoPath, targetSha, "SKILL.md");
      body = await gitShow(repoPath, targetSha, "skill.py");
      const parsed = parseManifest(manifestSource);
      if (!parsed.isOk()) {
        return rejectedResult(
          targetSha,
          `target_manifest_invalid: ${
            parsed.error.kind === "invalid_manifest"
              ? parsed.error.issues.join("; ")
              : parsed.error.message
          }`,
        );
      }
      manifest = parsed.value.manifest;
    } catch (e) {
      if (e instanceof GitOpsError && e.code === "file_not_found") {
        return rejectedResult(targetSha, "target_missing_source");
      }
      throw e;
    }

    if (manifest.name !== opts.name) {
      return rejectedResult(
        targetSha,
        `target_skill_mismatch: target sha belongs to skill '${manifest.name}', not '${opts.name}'`,
      );
    }

    const schemaErrors = this.#prevalidateSchemas(manifest);
    if (schemaErrors.length > 0) {
      return {
        name: opts.name,
        riskTier: "notify",
        status: "rejected",
        gitSha: targetSha,
        errors: schemaErrors,
      };
    }

    const classifierLog = classifyManifest(manifest);

    const mainSha = await getMainSha(repoPath);

    const result = await this.#store.executeRollback({
      name: opts.name,
      toGitSha: targetSha,
      tier: manifest.tier,
      riskTier: classifierLog.risk_tier,
      effects: manifest.effects,
      schedule: manifest.schedule ?? null,
      inputs: manifest.inputs,
      outputs: manifest.outputs ?? null,
      classifierLog,
      applyFilesystem: async () => {
        // Rollback rewrites main backward — pre-receive hook would normally
        // reject this, but `update-ref` bypasses hooks by design (see
        // bootstrapSkillsRepo). Pass `mainSha` as expectedOldSha for CAS.
        await updateRef(repoPath, "refs/heads/main", targetSha, mainSha ?? ZERO_SHA);
      },
    });

    // Warm the source cache with the rolled-back manifest+body so the next
    // invoke or listToolDefs read doesn't re-fetch from git.
    if (result.kind === "live") {
      const inputsValidator = this.#compileInputsValidator(manifest, "rollback-warm");
      this.#sourceCache.set(cacheKey(opts.name, targetSha), {
        manifest,
        body,
        inputsValidator,
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

  async deregister(opts: { name: string }): Promise<void> {
    const skill = await this.#store.getSkillByName(opts.name);
    if (!skill) {
      throw new Error(`skill not found: ${opts.name}`);
    }
    // Soft-disable rather than physically deleting — preserves the audit
    // trail in skill_deploys and skill_runs. A future hard-delete RPC could
    // exist, but at personal scale soft-disable covers the use case (revoke
    // an unsafe skill, retain the history).
    await this.#store.setSkillDisabled({ id: skill.id, disabled: true });
  }

  // --- Read paths ---

  async list(): Promise<readonly SkillSummary[]> {
    const rows = await this.#store.listEnabledSkills();
    return rows.map((r) => ({
      name: r.name,
      tier: r.tier,
      riskTier: r.riskTier,
      disabled: r.disabled,
      gitSha: r.gitSha,
    }));
  }

  async listToolDefs(): Promise<readonly SkillToolDef[]> {
    const rows = await this.#store.listEnabledSkills();
    const defs: SkillToolDef[] = [];
    for (const row of rows) {
      try {
        const cached = await this.#loadSourceForRow(row);
        defs.push({
          name: row.name,
          description: cached.manifest.description,
          inputs: row.inputs,
          tier: row.tier,
          riskTier: row.riskTier,
          gitSha: row.gitSha,
        });
      } catch (e) {
        // A skill row whose git source is unreadable shouldn't poison the
        // whole tool list — log and skip. Most likely cause: the repo was
        // moved/wiped between deploy and read; the user notices via the
        // missing tool and re-registers.
        log.warn(
          { skillName: row.name, gitSha: row.gitSha, err: e },
          "skipping skill in tool list — source unreadable",
        );
      }
    }
    return defs;
  }

  async invoke(opts: {
    name: string;
    inputs: unknown;
    trigger?: SkillRunTrigger;
  }): Promise<SkillRunResult> {
    const skill = await this.#store.getSkillByName(opts.name);
    if (!skill) {
      throw new Error(`skill not found: ${opts.name}`);
    }
    if (skill.disabled) {
      throw new Error(`skill is disabled: ${opts.name}`);
    }

    const cached = await this.#loadSourceForRow(skill);

    const validInputs = cached.inputsValidator(opts.inputs);
    if (!validInputs) {
      const errors = (cached.inputsValidator.errors ?? []).map(
        (e) => `${e.instancePath || "<root>"} ${e.message ?? "invalid"}`,
      );
      throw new InputValidationError(
        `inputs failed schema validation for skill '${opts.name}': ${errors.join("; ")}`,
      );
    }

    if (skill.tier !== "wasm") {
      throw new Error(
        `tier ${skill.tier} not supported in P3.1 (Tier 2 sysbox worker lands in P3.2)`,
      );
    }

    const run = await this.#store.insertRun({
      skillId: skill.id,
      trigger: opts.trigger ?? "manual",
      inputs: opts.inputs,
    });

    log.info(
      { runId: run.id, skillName: opts.name, trigger: opts.trigger ?? "manual" },
      "invoking tier-1 skill",
    );

    const ctxHandler = new DefaultCtxHandler({
      manifest: cached.manifest,
      runId: run.id,
      user: this.#user,
      memoryBankId: this.#memoryBankId,
      secretsStore: this.#secretsStore,
      memory: this.#memory,
      recordContextCall: (call) => this.#store.recordContextCall(call),
    });

    const result = await runOnWorker({
      taskId: run.id,
      skillName: skill.name,
      body: cached.body,
      inputs: opts.inputs,
      ...(cached.manifest.resources?.wall_clock_s !== undefined && {
        wallClockS: cached.manifest.resources.wall_clock_s,
      }),
      ...(this.#pyodidePackageCacheDir && {
        packageCacheDir: this.#pyodidePackageCacheDir,
      }),
      ctxHandler,
    });

    const finishedAt = new Date();
    if (result.ok) {
      const outputsValidationErr = this.#validateOutput(cached, result.output, opts.name);
      if (outputsValidationErr !== null) {
        await this.#store.updateRunResult({
          id: run.id,
          status: "error",
          output: null,
          error: outputsValidationErr,
          finishedAt,
        });
        return { runId: run.id, status: "error", error: outputsValidationErr };
      }
      await this.#store.updateRunResult({
        id: run.id,
        status: "success",
        output: result.output ?? null,
        error: null,
        finishedAt,
      });
      return { runId: run.id, status: "success", output: result.output };
    }
    await this.#store.updateRunResult({
      id: run.id,
      status: "error",
      output: null,
      error: result.error ?? "unknown_error",
      finishedAt,
    });
    return {
      runId: run.id,
      status: "error",
      ...(result.error !== undefined && { error: result.error }),
    };
  }

  // --- Test-only helper ---

  async __registerForTests(params: RegisterForTestsParams): Promise<SkillRow> {
    const parsed = parseManifest(params.manifestSource);
    if (!parsed.isOk()) {
      throw new Error(
        `__registerForTests: invalid manifest: ${
          parsed.error.kind === "invalid_manifest"
            ? parsed.error.issues.join("; ")
            : parsed.error.message
        }`,
      );
    }
    const manifest = parsed.value.manifest;
    if (manifest.name !== params.name) {
      throw new Error(
        `__registerForTests: manifest.name '${manifest.name}' != params.name '${params.name}'`,
      );
    }

    const gitSha = params.gitSha ?? hashStub(params.manifestSource + params.body);
    const insertParams: InsertSkillParams = {
      name: manifest.name,
      tier: manifest.tier,
      riskTier: "auto",
      effects: manifest.effects,
      schedule: manifest.schedule ?? null,
      gitSha,
      inputs: manifest.inputs,
      outputs: manifest.outputs ?? null,
    };

    const row = await this.#store.insertSkill(insertParams);
    await this.#store.insertDeploy({
      skillId: row.id,
      gitSha,
      priorGitSha: null,
      riskTier: "auto",
      status: "live",
      classifierLog: STUB_CLASSIFIER_LOG,
    });

    const inputsValidator = this.#compileInputsValidator(manifest, params.name);
    this.#sourceCache.set(cacheKey(manifest.name, gitSha), {
      manifest,
      body: params.body,
      inputsValidator,
    });

    return row;
  }

  // --- internals ---

  #requireRepoPath(method: string): string {
    if (!this.#skillsRepoPath) {
      throw new Error(
        `SkillRunner.${method}: skillsRepoPath not configured — set SkillRunnerOptions.skillsRepoPath`,
      );
    }
    return this.#skillsRepoPath;
  }

  #compileInputsValidator(manifest: SkillManifest, contextName: string): ValidateFunction {
    const validator = this.#ajv.compile(manifest.inputs as Record<string, unknown>);
    if ((validator as { $async?: boolean }).$async === true) {
      throw new Error(
        `${contextName}: skill '${manifest.name}' uses an $async JSON Schema; not supported`,
      );
    }
    return validator;
  }

  /**
   * Compile the manifest's `inputs` and (if declared) `outputs` JSON Schemas
   * with ajv to catch shape errors *before* the register flow advances main
   * or writes DB rows. Returns a flat list of human-readable errors; an empty
   * list means both schemas compile cleanly.
   *
   * Compilation failures (`ajv.compile` throws) and `$async` schemas are both
   * treated as deploy errors — they would either crash the worker on first
   * invoke or silently bypass validation, which is worse than a register
   * rejection up front.
   */
  #prevalidateSchemas(manifest: SkillManifest): string[] {
    const errors: string[] = [];

    try {
      this.#compileInputsValidator(manifest, "register-prevalidate");
    } catch (e) {
      errors.push(`invalid_inputs_schema: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (manifest.outputs !== undefined) {
      try {
        const v = this.#ajv.compile(manifest.outputs as Record<string, unknown>);
        if ((v as { $async?: boolean }).$async === true) {
          errors.push("invalid_outputs_schema: $async schemas are not supported");
        }
      } catch (e) {
        errors.push(`invalid_outputs_schema: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return errors;
  }

  /**
   * Load + cache the parsed manifest + compiled inputs validator for a
   * specific (name, gitSha) pair. Reads from the bare repo via `git show`
   * if not cached. The cache is keyed by SHA so a re-deploy automatically
   * picks up the new source on the next read.
   */
  async #loadSourceForRow(row: SkillRow): Promise<SkillSourceCacheEntry> {
    const key = cacheKey(row.name, row.gitSha);
    const cached = this.#sourceCache.get(key);
    if (cached) return cached;

    if (!this.#skillsRepoPath) {
      throw new Error(
        `no source for skill '${row.name}' — skillsRepoPath not configured and no test seed cached`,
      );
    }

    let manifestSource: string;
    let body: string;
    try {
      manifestSource = await gitShow(this.#skillsRepoPath, row.gitSha, "SKILL.md");
      body = await gitShow(this.#skillsRepoPath, row.gitSha, "skill.py");
    } catch (e) {
      if (e instanceof GitOpsError && (e.code === "ref_not_found" || e.code === "file_not_found")) {
        throw new Error(
          `no source for skill '${row.name}' at ${row.gitSha} (${e.code}) — repo and DB are out of sync`,
        );
      }
      throw e;
    }
    const parsed = parseManifest(manifestSource);
    if (!parsed.isOk()) {
      throw new Error(
        `cached SKILL.md for '${row.name}' @ ${row.gitSha} fails parse — registration drift?`,
      );
    }
    const manifest = parsed.value.manifest;
    const inputsValidator = this.#compileInputsValidator(manifest, "loadSource");
    const entry: SkillSourceCacheEntry = { manifest, body, inputsValidator };
    this.#sourceCache.set(key, entry);
    return entry;
  }

  #validateOutput(
    cached: SkillSourceCacheEntry,
    output: unknown,
    skillName: string,
  ): string | null {
    if (cached.manifest.outputs === undefined) return null;
    // Compile once per skill source — reuse via attaching to the entry.
    const validator =
      (
        cached as SkillSourceCacheEntry & {
          outputsValidator?: ValidateFunction;
        }
      ).outputsValidator ?? this.#ajv.compile(cached.manifest.outputs as Record<string, unknown>);
    (cached as { outputsValidator?: ValidateFunction }).outputsValidator = validator;
    if ((validator as { $async?: boolean }).$async === true) {
      // Defensive — manifest should never compile to async, but if it
      // somehow did the truthy check below would silently bypass validation.
      return `outputs schema for skill '${skillName}' is async — rejecting`;
    }
    const valid = validator(output);
    if (valid) return null;
    const issues = (validator.errors ?? []).map(
      (e) => `${e.instancePath || "<root>"} ${e.message ?? "invalid"}`,
    );
    return `output failed schema validation for skill '${skillName}': ${issues.join("; ")}`;
  }

  #registerResultToRpc(args: {
    name: string;
    branchSha: string;
    classifierLog: ClassifierLog;
    result: ExecuteRegisterResult;
    manifest: SkillManifest;
    body: string;
  }): RegisterResult {
    const { name, branchSha, classifierLog, result, manifest, body } = args;
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
      const inputsValidator = this.#compileInputsValidator(manifest, "register-warm");
      this.#sourceCache.set(cacheKey(name, branchSha), {
        manifest,
        body,
        inputsValidator,
      });
      return {
        name,
        riskTier: classifierLog.risk_tier,
        status: "live",
        gitSha: result.skill.gitSha,
      };
    }
    // pending_approval — also warm cache so a follow-up approve doesn't re-read.
    const inputsValidator = this.#compileInputsValidator(manifest, "register-warm");
    this.#sourceCache.set(cacheKey(name, branchSha), {
      manifest,
      body,
      inputsValidator,
    });
    return {
      name,
      riskTier: classifierLog.risk_tier,
      status: "pending_approval",
      gitSha: branchSha,
      pendingId: result.deploy.id,
    };
  }
}

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

function rejectedResult(gitSha: string, reason: string): RegisterResult {
  return {
    name: "",
    riskTier: "notify",
    status: "rejected",
    gitSha,
    errors: [reason],
  };
}

function cacheKey(name: string, gitSha: string): string {
  return `${name}@${gitSha}`;
}

/**
 * Deterministic short hash for stub git_sha values in tests. Not
 * cryptographically meaningful — only needs to be unique-enough so that
 * `updateSkillSha` round-trips don't collide on re-register.
 */
function hashStub(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 31) + input.charCodeAt(i)) | 0;
  }
  // Pad to look vaguely like a git short SHA.
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `stub${hex}`;
}
