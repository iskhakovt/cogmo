import { Ajv, type ValidateFunction } from "ajv";
import { logger } from "../logger.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { type CtxUser, DefaultCtxHandler } from "./ctx-handler.js";
import { parseManifest } from "./manifest.js";
import type {
  InsertSkillParams,
  SkillRiskTier,
  SkillRow,
  SkillRunTrigger,
  SkillStore,
  SkillTier,
} from "./store/index.js";
import type { ClassifierLog, SkillManifest } from "./types.js";
import { runOnWorker } from "./worker-wasm/host.js";

const log = logger.child({ component: "skills.runner" });

const STUB_CLASSIFIER_LOG: ClassifierLog = {
  classifier_version: "stub-0",
  risk_tier: "auto",
  declared_effects: [],
  detected_effects: [],
  declared_secrets: [],
  validation_errors: [],
};

export interface RegisterResult {
  name: string;
  riskTier: SkillRiskTier;
  status: "live" | "pending_approval" | "rejected";
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
 * Public contract for the skills runtime. P3.1 ships `list` + `invoke` end
 * to end; `register` / `approveDeploy` / `denyDeploy` / `rollback` /
 * `deregister` are part of the contract but throw `not_implemented` until
 * P3.3 fills in the classifier + git-merge flow. The interface is locked now
 * so consumers (CLI, future orchestrator tool registrar) don't change shape
 * across phases.
 */
export interface SkillRunner {
  /** P3.3. */
  register(opts: { branch: string }): Promise<RegisterResult>;
  /** P3.3. */
  approveDeploy(opts: { pendingId: string }): Promise<RegisterResult>;
  /** P3.3. */
  denyDeploy(opts: { pendingId: string; reason?: string }): Promise<void>;
  /** P3.3. */
  rollback(opts: { name: string; toGitSha?: string }): Promise<RegisterResult>;
  /** P3.3. */
  deregister(opts: { name: string }): Promise<void>;

  list(): Promise<readonly SkillSummary[]>;
  invoke(opts: {
    name: string;
    inputs: unknown;
    trigger?: SkillRunTrigger;
  }): Promise<SkillRunResult>;
}

/**
 * P3.1-only test helper. Inserts a skills row + live skill_deploys row from
 * a directly-handed manifest+body. Lets the runner test exercise `invoke`
 * end-to-end without going through git/classifier (P3.3 territory). Also
 * caches the body keyed by name so `invoke` can read it back.
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
  #pyodidePackageCacheDir: string | undefined;
  #ajv: Ajv;
  /**
   * Registered skill source — populated by `__registerForTests` until P3.3
   * swaps in a `git show <sha>:SKILL.md/.py` reader. Keyed by skill name.
   */
  #sourceCache = new Map<string, SkillSourceCacheEntry>();

  private constructor(opts: SkillRunnerOptions) {
    this.#store = opts.store;
    this.#secretsStore = opts.secretsStore;
    this.#memory = opts.memory;
    this.#user = opts.user;
    this.#memoryBankId = opts.memoryBankId;
    this.#pyodidePackageCacheDir = opts.pyodidePackageCacheDir;
    this.#ajv = new Ajv({ allErrors: true, strict: false });
  }

  /**
   * P3.1 does no async work — the factory is shaped this way for forward
   * compat with P3.3, which will pre-load skill source from git, eagerly
   * compile validators, and warm the Pyodide pool on boot. Keeping the
   * `static async create()` shape now means the wiring in `src/index.ts`
   * doesn't need to change again when that lands.
   */
  static async create(opts: SkillRunnerOptions): Promise<SkillRunnerImpl> {
    return new SkillRunnerImpl(opts);
  }

  // --- Public interface (P3.3 stubs) ---

  register(_opts: { branch: string }): Promise<RegisterResult> {
    return Promise.reject(
      new Error("SkillRunner.register: not_implemented_in_p3_1 (lands with classifier in P3.3)"),
    );
  }
  approveDeploy(_opts: { pendingId: string }): Promise<RegisterResult> {
    return Promise.reject(new Error("SkillRunner.approveDeploy: not_implemented_in_p3_1"));
  }
  denyDeploy(_opts: { pendingId: string; reason?: string }): Promise<void> {
    return Promise.reject(new Error("SkillRunner.denyDeploy: not_implemented_in_p3_1"));
  }
  rollback(_opts: { name: string; toGitSha?: string }): Promise<RegisterResult> {
    return Promise.reject(new Error("SkillRunner.rollback: not_implemented_in_p3_1"));
  }
  deregister(_opts: { name: string }): Promise<void> {
    return Promise.reject(new Error("SkillRunner.deregister: not_implemented_in_p3_1"));
  }

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

    const cached = this.#sourceCache.get(opts.name);
    if (!cached) {
      // Without git-show source loading (lands in P3.3), every invocable
      // skill must have been seeded via `__registerForTests` first.
      throw new Error(
        `no source for skill '${opts.name}' — register the skill first (P3.3 ships git-show)`,
      );
    }

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
      // TODO(P3.3): validate `result.output` against `cached.manifest.outputs`
      // (when declared) the same way we validate inputs above. Today a
      // skill declaring `outputs: {type: "object"}` and returning a string
      // silently stores the string. Lands with the classifier work since
      // `outputs` becomes load-bearing for tool-registration shapes.
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

  /**
   * P3.1-only seeding path. Inserts a skills row + live skill_deploys row
   * from a directly-handed manifest+body, populates the source cache so
   * `invoke()` can find it. Replaced by the real git-driven `register` RPC
   * in P3.3; the underscored name signals "tests only".
   */
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
    this.#sourceCache.set(manifest.name, {
      manifest,
      body: params.body,
      inputsValidator,
    });

    return row;
  }

  /**
   * Compile the manifest's `inputs` JSON Schema and reject any
   * `$async: true` schema. Ajv attaches `.$async = true` to validators
   * compiled from async schemas — those return Promises instead of
   * booleans, which our truthy-check at invoke time would treat as valid
   * and silently bypass validation. Skill manifests have no business
   * declaring async schemas; reject at compile time.
   *
   * Used by `__registerForTests` today; P3.3's `register` RPC must call
   * this on its load-from-git path too — otherwise the bypass returns.
   * (Cast to access the runtime property — Ajv's overloaded type
   * signature doesn't expose `$async` on the generic `ValidateFunction<T>`.)
   */
  #compileInputsValidator(manifest: SkillManifest, contextName: string): ValidateFunction {
    const validator = this.#ajv.compile(manifest.inputs as Record<string, unknown>);
    if ((validator as { $async?: boolean }).$async === true) {
      throw new Error(
        `${contextName}: skill '${manifest.name}' uses an $async JSON Schema; not supported`,
      );
    }
    return validator;
  }
}

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
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
