import { Ajv, type ValidateFunction } from "ajv";
import { err, ok, type Result } from "neverthrow";
import { computeNextRun } from "../agent/scheduling/cron.js";
import type { Service } from "../agent/service.js";
import type { Transactor } from "../db/index.js";
import { defaultSkillsImage } from "../env.js";
import { logger } from "../logger.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SandboxClient } from "../sandbox/index.js";
import { runGit, withGitAskpass } from "../secrets/git-askpass.js";
import { DEFAULT_GITHUB_IDENTITY_NAME, resolveGitHubIdentity } from "../secrets/github.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { classifyManifest, STUB_CLASSIFIER_VERSION } from "./classifier.js";
import { type CtxUser, DefaultCtxHandler } from "./ctx-handler.js";
import { type LockfileCompiler, makeSandboxLockfileCompiler, readLockfileAtSha } from "./deps.js";
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
import { readOriginUrl } from "./repo.js";
import type {
  ExecuteRegisterResult,
  InsertSkillParams,
  SkillRiskTier,
  SkillRow,
  SkillRunRecoveryPoint,
  SkillRunStatus,
  SkillRunTrigger,
  SkillStore,
  SkillTier,
} from "./store/index.js";
import type { ClassifierLog, SkillInputs, SkillManifest } from "./types.js";
import { runOnSysboxContainer } from "./worker-sysbox/host.js";
import {
  DEFAULT_POOL_OPTIONS,
  SysboxWorkerPool,
  type SysboxWorkerPoolOptions,
} from "./worker-sysbox/pool.js";
import type { InvokeResult } from "./worker-sysbox/worker.js";
import { type RunOnWorkerResult, runOnWorker } from "./worker-wasm/host.js";

/**
 * Default tier-2 container image when the constructor doesn't override it.
 * Production wiring (`src/index.ts`) always passes `tier2Image:
 * env.COGMO_SKILLS_IMAGE`, so this default only matters for tests that
 * construct a runner without an explicit image AND actually invoke a
 * tier-container skill (the integration test does the latter — it overrides).
 * Shares the helper with `env.ts` so the two never drift.
 */
const DEFAULT_TIER2_IMAGE = defaultSkillsImage();

/**
 * Translate a manifest's `resources` block into the partial `ResourceLimits`
 * the tier-2 host expects. Naming differs intentionally: skills declare
 * `cpu_shares` (integer 1-4) and `memory_mb` (megabytes), while the sandbox
 * speaks fractional `cpus` and `memory_bytes` — so this function owns the
 * conversion. Returns only fields the manifest set; the host fills the rest
 * from `DEFAULT_RESOURCE_LIMITS`. Exported for direct unit-testing — the
 * mapping has been wrong by omission once already (cpu_shares dropped).
 */
export function mapManifestResourceLimits(resources: SkillManifest["resources"] | undefined): {
  memory_bytes?: number;
  cpus?: number;
} {
  return {
    ...(resources?.memory_mb !== undefined && {
      memory_bytes: resources.memory_mb * 1024 * 1024,
    }),
    ...(resources?.cpu_shares !== undefined && { cpus: resources.cpu_shares }),
  };
}

const log = logger.child({ component: "skills.runner" });

const ZERO_SHA = "0000000000000000000000000000000000000000";

function rowToSummary(r: SkillRow): SkillSummary {
  return {
    name: r.name,
    tier: r.tier,
    riskTier: r.riskTier,
    disabled: r.disabled,
    gitSha: r.gitSha,
  };
}

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
  /**
   * JSON Schema as declared in the manifest. Structurally compatible with
   * `JsonSchema` (in `src/llm/types.ts`) — both pin `type: "object"` and
   * permit extra keys via index signature — so the dynamic-tool-list builder
   * forwards it to the LLM without an `as unknown` cast.
   */
  inputs: SkillInputs;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  gitSha: string;
}

/**
 * Failure reasons for {@link SkillRunner.enable}. Exposed as a discriminated
 * union (rather than thrown errors) because the call sites — Telegram
 * adapter, CLI — render each case with a different user-facing message and
 * we want exhaustiveness checking instead of string parsing.
 */
export type EnableFailureReason = "not_found" | "no_live_deploy";

export type EnableResult =
  | { kind: "enabled"; name: string; gitSha: string }
  | { kind: "already_enabled"; name: string; gitSha: string }
  | { kind: "rejected"; name: string; reason: EnableFailureReason };

/**
 * Mirror of {@link EnableResult} for {@link SkillRunner.deregister}.
 * Returning a discriminated union (rather than throwing on "not found")
 * lets transport adapters map cases without string-matching the error
 * message — a fragile coupling to the runner's wording. Only `not_found`
 * is a domain failure today; DB / infrastructure errors still throw.
 */
export type DeregisterFailureReason = "not_found";

export type DeregisterResult =
  | { kind: "deregistered"; name: string }
  | { kind: "rejected"; name: string; reason: DeregisterFailureReason };

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
  /**
   * Soft-disable a skill. Idempotent on already-disabled rows (returns
   * `kind: "deregistered"` either way — soft-disable already supports
   * the no-op case at the store layer). See {@link DeregisterResult}.
   */
  deregister(opts: { name: string }): Promise<DeregisterResult>;
  /**
   * Re-activate a soft-disabled skill. Refuses if the skill was never live
   * at its current `gitSha` (denied-on-first-deploy case) — re-enabling
   * would otherwise smuggle un-approved code past the approval gate.
   * Idempotent: enabling an already-enabled skill returns `already_enabled`
   * rather than erroring. See {@link EnableResult}.
   */
  enable(opts: { name: string }): Promise<EnableResult>;

  list(): Promise<readonly SkillSummary[]>;
  /**
   * Like {@link list} but includes disabled skills too. Used by operator-
   * facing surfaces (`/skills` in Telegram) where a previously-disabled
   * row needs to be visible so the operator can `enable` it back.
   */
  listAll(): Promise<readonly SkillSummary[]>;
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
    /**
     * Deterministic-per-fire token. When provided, `runner.invoke` honours
     * the Stripe-pattern recovery_point state machine: a retry with the
     * same key resolves to the existing run row and replays only the
     * pending phase (or returns the cached terminal result). When omitted,
     * the invocation is one-shot — no idempotency guarantee, no
     * cross-attempt deduplication.
     *
     * Suggested key shapes (deterministic across retries of the same
     * logical fire):
     *   - cron-fire: `skill-cron:${skillId}:${scheduledFor}`
     *   - agent-loop tool call: `skill-tool:${conversationId}:${toolUseId}`
     *
     * See design/skills.md → Exactly-once invocation.
     */
    idempotencyKey?: string;
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
  runInTx: Transactor;
  secretsStore: SecretsStore;
  memory: MemoryProvider;
  /** File workspace passed to ctx.files.* — same surface as the agent's file tools. */
  files: Service["files"];
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
  /**
   * Sandbox handle for running tier-2 (sysbox container) skills. Optional —
   * deployments without `SANDBOX_RUNTIME` set leave it undefined; tier-2
   * skills then fail with a clear `tier_2_unavailable` error at invoke time.
   * Tier-1 (Pyodide WASM) skills work either way.
   */
  sandbox?: SandboxClient;
  /**
   * Container image for tier-2 skills. Defaults to `python:3.14-slim`.
   * Override when shipping a Cogmo-baked image with deps pre-installed.
   */
  tier2Image?: string;
  /**
   * Pool sizing overrides. Defaults from `DEFAULT_POOL_OPTIONS` are tuned
   * for personal scale (min=1, max=3, recycle every 500 tasks or 24h).
   * Tests can shrink to `min: 0` to avoid eager-spawning a worker on
   * `create()`.
   */
  poolOptions?: Partial<
    Pick<
      SysboxWorkerPoolOptions,
      | "min"
      | "max"
      | "recycleAfterTasks"
      | "recycleAfterMs"
      | "idleShutdownMs"
      | "idleSweepIntervalMs"
    >
  >;
  /**
   * Clock override for testability. Used by the lifecycle paths
   * (`register` / `approveDeploy` / `rollback`) that seed `next_run_at`
   * from the manifest's cron. Defaults to `() => new Date()`. Matches the
   * `now` injection on the cron ticker — keeps the test surface uniform
   * across the module.
   */
  clock?: () => Date;
  /**
   * Lockfile compiler used at register / approve / rollback to re-resolve
   * the manifest's `dependencies` and byte-compare against the committed
   * `requirements.lock`. Mismatch fails the deploy with a clear stale-
   * lockfile error.
   *
   * Defaults to a {@link makeSandboxLockfileCompiler} backed by `sandbox`
   * + `tier2Image` when both are configured. When the deployment has no
   * tier-2 sandbox (tier-1-only deployments, or test paths that omit
   * `sandbox`), the field is undefined and the runner downgrades to
   * "presence + hash only" — lockfile must exist and parse, but the
   * resolver isn't re-run. Set explicitly in tests to swap a stub.
   */
  lockfileCompiler?: LockfileCompiler;
}

interface SkillSourceCacheEntry {
  manifest: SkillManifest;
  body: string;
  inputsValidator: ValidateFunction;
  /**
   * Compiled lazily on first invoke that has a manifest.outputs to validate
   * against. Stored on the cache entry itself so subsequent invocations reuse
   * the validator instead of re-compiling per call. `undefined` until first
   * use; remains `undefined` for skills without declared outputs.
   */
  outputsValidator?: ValidateFunction;
  /**
   * Raw `requirements.lock` bytes when the manifest declares dependencies.
   * Cached alongside `body` so the populator on first invoke doesn't pay
   * a second `git show` per task. `undefined` when the manifest declares
   * no deps (no lockfile is committed).
   */
  lockfileContents?: string;
}

export class SkillRunnerImpl implements SkillRunner {
  #store: SkillStore;
  #runInTx: Transactor;
  #secretsStore: SecretsStore;
  #memory: MemoryProvider;
  #files: Service["files"];
  #user: CtxUser;
  #memoryBankId: string;
  #skillsRepoPath: string | undefined;
  #pyodidePackageCacheDir: string | undefined;
  #sandbox: SandboxClient | undefined;
  #tier2Image: string;
  #clock: () => Date;
  #lockfileCompiler: LockfileCompiler | undefined;
  /**
   * Lazily-created warm pool over `#sandbox`. Created on first tier-2
   * invocation, not at boot — keeps cogmo serve startup independent of
   * sandbox availability so an unreachable Daytona doesn't fail boot
   * for deployments that may never invoke a tier-2 skill. Concurrent
   * first-callers share `#poolPromise`; on init failure the promise
   * clears so the next caller retries (no permanent poisoning from a
   * transient Daytona blip).
   */
  #pool: SysboxWorkerPool | undefined;
  #poolPromise: Promise<SysboxWorkerPool> | undefined;
  #poolOptions: SkillRunnerOptions["poolOptions"];
  /**
   * Set in `shutdown()` to block any subsequent `#ensurePool` from
   * spinning up a new pool — without it, an `invoke()` racing in after
   * shutdown completes would lazy-create a pool that no shutdown hook
   * is left to dispose. Production wiring closes the runner on
   * SIGTERM and the process exits, but the post-shutdown invoke is a
   * real test surface and a real edge in any future graceful-restart
   * path.
   */
  #disposed = false;
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
    this.#runInTx = opts.runInTx;
    this.#secretsStore = opts.secretsStore;
    this.#memory = opts.memory;
    this.#files = opts.files;
    this.#user = opts.user;
    this.#memoryBankId = opts.memoryBankId;
    this.#skillsRepoPath = opts.skillsRepoPath;
    this.#pyodidePackageCacheDir = opts.pyodidePackageCacheDir;
    this.#sandbox = opts.sandbox;
    this.#tier2Image = opts.tier2Image ?? DEFAULT_TIER2_IMAGE;
    this.#poolOptions = opts.poolOptions;
    this.#clock = opts.clock ?? (() => new Date());
    this.#ajv = new Ajv({ allErrors: true, strict: false });
    // Explicit override wins; otherwise default to a sandbox-backed
    // compiler when the runtime has both a sandbox and a tier-2 image
    // (the cogmo-skills image carries `uv`). Tier-1-only deployments
    // fall through to undefined → presence + hash check only.
    this.#lockfileCompiler =
      opts.lockfileCompiler ??
      (this.#sandbox
        ? makeSandboxLockfileCompiler({
            sandbox: this.#sandbox,
            image: this.#tier2Image,
          })
        : undefined);
  }

  /**
   * Compute the first occurrence of the manifest's `schedule` after the
   * current clock tick, using the user's timezone. Returns null when the
   * manifest has no schedule — preserves the all-or-none invariant on
   * `(schedule, scheduleNextRunAt)`. The timezone is sourced from
   * `this.#user.timezone` (single source of truth — the bootstrap path
   * sets it from `env.USER_TIMEZONE`).
   */
  #computeScheduleNextRunAt(schedule: string | null): Date | null {
    if (schedule === null) return null;
    return computeNextRun(schedule, this.#user.timezone, this.#clock());
  }

  /**
   * Read the committed `requirements.lock` at a deploy sha and — when a
   * compiler is configured — re-resolve the manifest's dependencies
   * against `uv pip compile` to verify the committed lockfile is
   * current. Returns the lockfile hash on success.
   *
   * Returns:
   *   - `ok(null)` — manifest declares no deps; no lockfile is expected
   *     and any committed `requirements.lock` is ignored.
   *   - `ok(<hex>)` — manifest declares deps and a non-empty lockfile is
   *     present. When a compiler is configured, fresh resolver output
   *     byte-matches the committed file. `<hex>` is `sha256(contents)`.
   *   - `err(message)` — manifest declares deps and one of: the
   *     committed lockfile is missing/empty, the resolver couldn't run
   *     ('transport_failed'), the resolver itself failed
   *     ('resolver_failed'), or the committed file is stale relative
   *     to a fresh resolve. The caller surfaces the message verbatim
   *     as the register `errors[]` payload.
   *
   * When `#lockfileCompiler` is undefined OR `verifyFresh` is false,
   * verification degrades to presence + hash only — the committed
   * file is trusted as-is. `verifyFresh: false` is the rollback
   * mode: the target lockfile was valid at deploy time, hashes are
   * still pinned, and a wheel yanked from PyPI since shouldn't block
   * the operator from rewinding to a known-good revision.
   */
  async #readManifestLockfile(
    repoPath: string,
    gitSha: string,
    manifest: SkillManifest,
    opts: { verifyFresh: boolean } = { verifyFresh: true },
  ): Promise<Result<{ hash: string; contents: string } | null, string>> {
    if (manifest.dependencies.length === 0) {
      return ok(null);
    }
    const snapshot = await readLockfileAtSha(repoPath, gitSha);
    if (snapshot.isErr()) {
      return err(
        `requirements_lock_${snapshot.error.kind}: declared ${manifest.dependencies.length} dependencies but ${snapshot.error.message}. Run 'uv pip compile --generate-hashes --no-header' and commit the result.`,
      );
    }

    if (opts.verifyFresh && this.#lockfileCompiler) {
      const compiled = await this.#lockfileCompiler.compile(manifest.dependencies);
      if (compiled.isErr()) {
        return err(`requirements_lock_${compiled.error.kind}: ${compiled.error.message}`);
      }
      if (compiled.value !== snapshot.value.contents) {
        return err(
          "requirements_lock_stale: committed requirements.lock differs from a fresh 'uv pip compile --generate-hashes --no-header'. Re-run the compile against your declared dependencies and recommit.",
        );
      }
    }

    return ok({ hash: snapshot.value.hash, contents: snapshot.value.contents });
  }

  static async create(opts: SkillRunnerOptions): Promise<SkillRunnerImpl> {
    // Pool init is deferred to first tier-2 invocation — cogmo serve
    // boots independently of sandbox availability. See `#ensurePool`.
    return new SkillRunnerImpl(opts);
  }

  /**
   * Lazily construct the tier-2 worker pool, dedup'ing concurrent
   * first-callers behind one in-flight promise. On success the pool
   * is cached on `#pool` and the promise is cleared. On failure the
   * promise is cleared so the next caller retries — keeps a transient
   * Daytona blip from poisoning the runner permanently.
   */
  async #ensurePool(): Promise<SysboxWorkerPool> {
    if (this.#disposed) {
      throw new Error("SkillRunnerImpl: tier-2 pool requested after shutdown");
    }
    if (this.#pool) return this.#pool;
    if (this.#poolPromise) return this.#poolPromise;
    const sandbox = this.#sandbox;
    if (!sandbox) {
      // Caller paths gate on `#sandbox` before reaching here; this
      // guard exists only to narrow `sandbox` for the `create` call.
      throw new Error("invariant: #ensurePool called without a sandbox");
    }
    this.#poolPromise = (async () => {
      try {
        const pool = await SysboxWorkerPool.create({
          sandbox,
          image: this.#tier2Image,
          ...DEFAULT_POOL_OPTIONS,
          ...this.#poolOptions,
        });
        this.#pool = pool;
        return pool;
      } finally {
        this.#poolPromise = undefined;
      }
    })();
    return this.#poolPromise;
  }

  /**
   * Tear down the warm pool. Idempotent. Bootstrap callers wire this into
   * graceful-shutdown when they add SIGTERM handling. Leaves tier-1 (Pyodide)
   * untouched — those workers are short-lived per-call and self-clean.
   *
   * After `shutdown()` returns, any `invoke()` that hits the tier-2
   * path throws `tier-2 pool requested after shutdown` — the
   * `#disposed` flag short-circuits `#ensurePool` so a post-shutdown
   * invoke can't lazy-create a fresh pool that nobody's left to clean up.
   */
  async shutdown(): Promise<void> {
    // Set `#disposed` before awaiting in-flight init so a racing
    // `invoke()` can't kick off a fresh `#ensurePool` after this point.
    this.#disposed = true;
    if (this.#poolPromise) {
      await this.#poolPromise.catch(() => undefined);
    }
    if (this.#pool) {
      await this.#pool.dispose();
      this.#pool = undefined;
    }
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

    const classifierLog = await classifyManifest(manifest, body);
    if (classifierLog.validation_errors.length > 0) {
      // Undeclared dangerous effects → reject the deploy outright with
      // the per-effect labels surfaced to the user. Don't even insert
      // a `denied` deploy row: the AST path is a pre-flight, not a
      // human approval, and storing a denied row for "manifest typo"
      // pollutes the audit log meant for real approval-gate events.
      return rejectedResult(branchSha, classifierLog.validation_errors.join("; "));
    }

    const lockfileResult = await this.#readManifestLockfile(repoPath, branchSha, manifest);
    if (lockfileResult.isErr()) {
      return rejectedResult(branchSha, lockfileResult.error);
    }
    const lockfile = lockfileResult.value;

    const schedule = manifest.schedule ?? null;
    const result = await this.#runInTx((tx) =>
      this.#store.executeRegister(tx, {
        name: manifest.name,
        tier: manifest.tier,
        riskTier: classifierLog.risk_tier,
        effects: manifest.effects,
        schedule,
        scheduleNextRunAt: this.#computeScheduleNextRunAt(schedule),
        branchTipSha: branchSha,
        lockfileHash: lockfile?.hash ?? null,
        inputs: manifest.inputs,
        outputs: manifest.outputs ?? null,
        classifierLog,
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
      await this.#mirrorMainToRemote(branchSha);
    }

    return this.#registerResultToRpc({
      name: manifest.name,
      branchSha,
      classifierLog,
      result,
      manifest,
      body,
      lockfile,
    });
  }

  async approveDeploy(opts: { pendingId: string; approvedBy?: string }): Promise<RegisterResult> {
    const repoPath = this.#requireRepoPath("approveDeploy");

    const deploy = await this.#runInTx((tx) => this.#store.getDeployById(tx, opts.pendingId));
    if (!deploy) {
      return rejectedResult("", `deploy_not_found: ${opts.pendingId}`);
    }
    if (deploy.status !== "pending_approval") {
      return rejectedResult(deploy.gitSha, `deploy_not_pending: status is '${deploy.status}'`);
    }

    const skill = await this.#runInTx((tx) => this.#store.getSkillById(tx, deploy.skillId));
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

    const lockfileResult = await this.#readManifestLockfile(repoPath, deploy.gitSha, manifest);
    if (lockfileResult.isErr()) {
      return rejectedResult(deploy.gitSha, lockfileResult.error);
    }
    const lockfile = lockfileResult.value;

    const schedule = manifest.schedule ?? null;
    const result = await this.#runInTx((tx) =>
      this.#store.executeApprove(tx, {
        pendingId: opts.pendingId,
        approvedBy: opts.approvedBy ?? null,
        tier: manifest.tier,
        // Preserve the deploy row's classified tier (which is what the user
        // approved). Re-classifying here could promote an `approve` deploy to a
        // different tier mid-flow, which would be confusing.
        riskTier: deploy.riskTier,
        effects: manifest.effects,
        schedule,
        scheduleNextRunAt: this.#computeScheduleNextRunAt(schedule),
        lockfileHash: lockfile?.hash ?? null,
        inputs: manifest.inputs,
        outputs: manifest.outputs ?? null,
        applyFilesystem: async () => {
          await updateRef(repoPath, "refs/heads/main", deploy.gitSha, mainSha ?? ZERO_SHA);
        },
      }),
    );

    if (result.kind === "live") {
      // Warm the source cache with the just-approved manifest so the next
      // listToolDefs / invoke read doesn't re-fetch from git.
      const inputsValidator = this.#compileInputsValidator(manifest, "approve-warm");
      this.#sourceCache.set(cacheKey(skill.name, deploy.gitSha), {
        manifest,
        body,
        inputsValidator,
        // Must mirror `#loadSourceForRow` — skills with deps require
        // lockfileContents at invoke time. Skipping it here meant the
        // first invoke after approve ran without the venv activated.
        ...(lockfile && { lockfileContents: lockfile.contents }),
      });
      // Mirror the new main SHA to the configured remote — same rationale as
      // register's mirror call.
      await this.#mirrorMainToRemote(deploy.gitSha);
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
    // Log the reason here — denyPendingDeploy intentionally drops it (no
    // `denied_reason` column yet) and the CLI accepts a multi-word reason
    // that would otherwise vanish without a trace. Audit trail lives in the
    // log line for now; promote to a column once a real consumer needs to
    // query it.
    log.info({ pendingId: opts.pendingId, reason: opts.reason ?? null }, "denying skill deploy");
    await this.#runInTx((tx) =>
      this.#store.denyPendingDeploy(tx, {
        pendingId: opts.pendingId,
        reason: opts.reason ?? null,
      }),
    );
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
    const lockfileResult = await this.#readManifestLockfile(repoPath, targetSha, manifest, {
      verifyFresh: false,
    });
    if (lockfileResult.isErr()) {
      return rejectedResult(targetSha, lockfileResult.error);
    }
    const lockfile = lockfileResult.value;

    const schedule = manifest.schedule ?? null;
    const result = await this.#runInTx((tx) =>
      this.#store.executeRollback(tx, {
        name: opts.name,
        toGitSha: targetSha,
        tier: manifest.tier,
        riskTier: classifierLog.risk_tier,
        effects: manifest.effects,
        schedule,
        scheduleNextRunAt: this.#computeScheduleNextRunAt(schedule),
        lockfileHash: lockfile?.hash ?? null,
        inputs: manifest.inputs,
        outputs: manifest.outputs ?? null,
        classifierLog,
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
      const inputsValidator = this.#compileInputsValidator(manifest, "rollback-warm");
      this.#sourceCache.set(cacheKey(opts.name, targetSha), {
        manifest,
        body,
        inputsValidator,
        // Same invariant as approve-warm above.
        ...(lockfile && { lockfileContents: lockfile.contents }),
      });
      // Rollback rewinds main backwards, so the remote push needs `force`. We
      // gate with `--force-with-lease=refs/heads/main:<mainSha>` — if anything
      // moved remote main between our last fetch and this push, the lease
      // fails and the operator is told to investigate rather than silently
      // overwriting a divergent remote. `mainSha` is null when local main is
      // unborn (first ever register-then-rollback before any pushes
      // succeeded); `ZERO_SHA` is git's convention for "ref must not exist"
      // in lease syntax, which is the correct lease for that edge.
      await this.#mirrorMainToRemote(targetSha, {
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

  async deregister(opts: { name: string }): Promise<DeregisterResult> {
    return this.#runInTx(async (tx) => {
      const skill = await this.#store.getSkillByName(tx, opts.name);
      if (!skill) {
        return { kind: "rejected", name: opts.name, reason: "not_found" } as const;
      }
      // Soft-disable rather than physically deleting — preserves the audit
      // trail in skill_deploys and skill_runs. A future hard-delete RPC could
      // exist, but at personal scale soft-disable covers the use case (revoke
      // an unsafe skill, retain the history). `setSkillDisabled` is
      // idempotent at the store layer, so calling deregister on an
      // already-disabled row is a SQL no-op and returns `deregistered`.
      await this.#store.setSkillDisabled(tx, { id: skill.id, disabled: true });
      return { kind: "deregistered", name: skill.name } as const;
    });
  }

  async enable(opts: { name: string }): Promise<EnableResult> {
    return this.#runInTx(async (tx) => {
      const skill = await this.#store.getSkillByName(tx, opts.name);
      if (!skill) {
        return { kind: "rejected", name: opts.name, reason: "not_found" } as const;
      }
      if (!skill.disabled) {
        return {
          kind: "already_enabled",
          name: skill.name,
          gitSha: skill.gitSha,
        } as const;
      }
      // Approval-gate guard: a `disabled=true` row with no matching live
      // deploy means the current sha was either denied at first registration
      // or has otherwise never been signed off. Flipping disabled=false
      // here would activate that code with no human review — the same hole
      // a `/disable foo` → `/enable foo` cycle would open if /disable
      // weren't already gated to live skills upstream. Refuse, force the
      // operator through `register` again.
      const hasLive = await this.#store.hasLiveDeployForSkill(tx, {
        skillId: skill.id,
        gitSha: skill.gitSha,
      });
      if (!hasLive) {
        return { kind: "rejected", name: skill.name, reason: "no_live_deploy" } as const;
      }
      await this.#store.setSkillDisabled(tx, { id: skill.id, disabled: false });
      return { kind: "enabled", name: skill.name, gitSha: skill.gitSha } as const;
    });
  }

  // --- Read paths ---

  async list(): Promise<readonly SkillSummary[]> {
    const rows = await this.#runInTx((tx) => this.#store.listEnabledSkills(tx));
    return rows.map(rowToSummary);
  }

  async listAll(): Promise<readonly SkillSummary[]> {
    const rows = await this.#runInTx((tx) => this.#store.listAllSkills(tx));
    return rows.map(rowToSummary);
  }

  async listToolDefs(): Promise<readonly SkillToolDef[]> {
    const rows = await this.#runInTx((tx) => this.#store.listEnabledSkills(tx));
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
    idempotencyKey?: string;
  }): Promise<SkillRunResult> {
    // --- Pre-flight (cheap, idempotent reads; re-runs freely on retry) ---
    // Typed-error throws here happen *before* any DB write. The cron-fire
    // handler etc. catch them at the function-handler level and return
    // non-retrying skipped results without touching state.
    const skill = await this.#runInTx((tx) => this.#store.getSkillByName(tx, opts.name));
    if (!skill) {
      throw new SkillNotFoundError(opts.name);
    }
    if (skill.disabled) {
      throw new SkillDisabledError(opts.name);
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

    if (skill.tier === "container" && !this.#sandbox) {
      throw new SandboxUnavailableError(opts.name);
    }

    // Empty-string idempotency keys would all collide on the UNIQUE
    // constraint as if they were the same key — a silent contract bug
    // for any caller that constructs a key from optional fields and
    // forgets to validate. Refuse explicitly so the failure surfaces at
    // the API boundary, not deep in the recovery branch.
    if (opts.idempotencyKey === "") {
      throw new InputValidationError(
        `idempotencyKey must be a non-empty string when provided (skill '${opts.name}')`,
      );
    }

    const trigger: SkillRunTrigger = opts.trigger ?? "manual";

    // --- Start or recover the run row ---
    //
    // Keyed path: `startOrRecoverRun` inserts a fresh row with
    // `recovery_point='started'` and returns `kind: 'new'`. If a row with
    // the same key already exists (prior crashed attempt, or a successful
    // run being replayed), it returns `kind: 'recovered'` with the row
    // locked FOR UPDATE.
    //
    // Non-keyed path: plain `insertRun` → fresh row every call. No
    // exactly-once semantic; the runner behaves identically to the
    // pre-idempotency contract.
    let runId: string;
    let runCreatedAt: Date;
    let recoveryPoint: SkillRunRecoveryPoint;
    let savedOutput: unknown | null = null;
    let savedError: string | null = null;

    // Hoist the key out so the narrowed `string` type survives across
    // the `runInTx` closure (TS doesn't always retain narrowing through
    // captured `opts.idempotencyKey` references inside an async lambda).
    const idempotencyKey = opts.idempotencyKey;
    if (idempotencyKey !== undefined) {
      const { kind, row } = await this.#runInTx((tx) =>
        this.#store.startOrRecoverRun(tx, {
          skillId: skill.id,
          trigger,
          inputs: opts.inputs,
          idempotencyKey,
        }),
      );
      runId = row.id;
      runCreatedAt = row.createdAt;
      recoveryPoint = row.recoveryPoint;
      savedOutput = row.output;
      savedError = row.error;

      if (kind === "recovered" && recoveryPoint === "finished") {
        // Terminal cached result. Reconstruct SkillRunResult shape and
        // return without touching the runtime or the row.
        log.info(
          { runId, skillName: opts.name, idempotencyKey },
          "replaying cached terminal skill run (recovery_point=finished)",
        );
        return reconstructFinishedResult(runId, row.status, savedOutput, savedError);
      }
      if (kind === "recovered" && recoveryPoint === "started") {
        // The row is in flight: either a prior attempt crashed
        // mid-execute, or another worker is currently executing this
        // same key. The runner can't tell those apart — both leave the
        // row at `recovery_point='started'`. Conservative refusal in
        // both cases: re-executing risks double-firing non-idempotent
        // side effects (ctx.memory.write, outbound HTTP, etc.).
        throw new SkillInflightError(opts.name, runId);
      }
      // kind === 'new' (fresh start) OR kind === 'recovered' &&
      // recovery_point === 'executed' (execute succeeded last time, just
      // finalize). Both fall through.
    } else {
      const run = await this.#runInTx((tx) =>
        this.#store.insertRun(tx, { skillId: skill.id, trigger, inputs: opts.inputs }),
      );
      runId = run.id;
      runCreatedAt = run.createdAt;
      recoveryPoint = "started";
    }

    log.info(
      {
        runId,
        skillName: opts.name,
        tier: skill.tier,
        trigger,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
        ...(recoveryPoint !== "started" && { resumingFrom: recoveryPoint }),
      },
      recoveryPoint === "started" ? "invoking skill" : "resuming skill from executed phase",
    );

    // --- Execute phase (skipped on `recovery_point='executed'` replay) ---
    if (recoveryPoint === "started") {
      const ctxHandler = new DefaultCtxHandler({
        manifest: cached.manifest,
        runId,
        user: this.#user,
        memoryBankId: this.#memoryBankId,
        secretsStore: this.#secretsStore,
        runInTx: this.#runInTx,
        memory: this.#memory,
        files: this.#files,
        recordContextCall: (call) => this.#runInTx((tx) => this.#store.recordContextCall(tx, call)),
      });

      const result = await this.#dispatchToRuntime(skill, cached, opts.inputs, ctxHandler, runId);
      const finishedAt = new Date();
      // Build the resource_usage blob once — `wallClockMs` is always derived
      // from the host-side timestamps; `peakMemoryBytes` rides whatever the
      // runtime contributed via `result.rusage` (tier-2 populates it from
      // `getrusage`, tier-1 leaves it unset and we store null).
      const resourceUsage = {
        wallClockMs: Math.max(0, finishedAt.getTime() - runCreatedAt.getTime()),
        peakMemoryBytes: result.rusage?.peakMemoryBytes ?? null,
      };
      savedOutput = result.ok ? (result.output ?? null) : null;
      savedError = result.ok ? null : (result.error ?? "unknown_error");
      await this.#runInTx((tx) =>
        this.#store.transitionToExecuted(tx, {
          id: runId,
          output: savedOutput,
          error: savedError,
          resourceUsage,
          finishedAt,
        }),
      );
    }

    // --- Validate + finalize phase (runs for new + recovered-executed
    // alike). Output validation is pure, so replaying it on a recovered
    // row produces the same verdict as the original attempt — safe.
    let finalStatus: SkillRunStatus;
    let finalOutput: unknown | null = savedOutput;
    let finalError: string | null = savedError;
    if (savedError !== null) {
      finalStatus = "error";
    } else {
      const outputErr = this.#validateOutput(cached, savedOutput, opts.name);
      if (outputErr !== null) {
        finalStatus = "error";
        finalOutput = null;
        finalError = outputErr;
      } else {
        finalStatus = "success";
      }
    }

    await this.#runInTx((tx) =>
      this.#store.transitionToFinished(tx, {
        id: runId,
        status: finalStatus,
        output: finalOutput,
        error: finalError,
      }),
    );

    return reconstructFinishedResult(runId, finalStatus, finalOutput, finalError);
  }

  /**
   * Per-tier dispatch to the worker runtime. Extracted from `invoke` so
   * the execute path stays readable — every line above is pre-flight or
   * recovery branching, every line after is finalize.
   */
  async #dispatchToRuntime(
    skill: SkillRow,
    cached: SkillSourceCacheEntry,
    inputs: unknown,
    ctxHandler: DefaultCtxHandler,
    taskId: string,
  ): Promise<RunOnWorkerResult | InvokeResult> {
    const wallClockS = cached.manifest.resources?.wall_clock_s;
    // Switch + `never` exhaustiveness so a future SkillTier value (added to
    // the pgEnum) is a compile-time miss here rather than a silent route
    // through the sysbox path.
    switch (skill.tier) {
      case "wasm":
        return runOnWorker({
          taskId,
          skillName: skill.name,
          body: cached.body,
          inputs,
          ...(wallClockS !== undefined && { wallClockS }),
          ...(this.#pyodidePackageCacheDir && {
            packageCacheDir: this.#pyodidePackageCacheDir,
          }),
          ctxHandler,
        });
      case "container": {
        const sandbox = this.#sandbox;
        if (!sandbox) {
          // Caught above in invoke by `tier === "container" && !sandbox`;
          // this guard narrows for the call below.
          throw new Error("invariant: sandbox unset on container tier path");
        }
        // Per-skill resource overrides are honoured via a one-shot
        // container — the pool runs every worker at the default resource
        // budget, so a skill that wants 2 GB of RAM can't share a 512 MB
        // worker. Bypass the pool when overrides are declared; pay the
        // ~1-2s cold-start that pre-pool tier-2 skills paid every time.
        // This is rare: most skills don't override and ride the warm path.
        const overrides = mapManifestResourceLimits(cached.manifest.resources);
        const isolation = cached.manifest.isolation;
        // Invariant: lockfile_hash != null ⇒ cached.lockfileContents
        // must be present. Loud throw if not — silently dropping deps
        // would run a dep-locked skill without its venv.
        let deps: { lockfileHash: string; lockfileContents: string } | undefined;
        if (skill.lockfileHash !== null) {
          if (cached.lockfileContents === undefined) {
            throw new Error(
              `invariant: skill '${skill.name}' has lockfile_hash but cache missing lockfileContents`,
            );
          }
          deps = {
            lockfileHash: skill.lockfileHash,
            lockfileContents: cached.lockfileContents,
          };
        }
        if (overrides.cpus !== undefined || overrides.memory_bytes !== undefined) {
          return runOnSysboxContainer({
            taskId,
            skillName: skill.name,
            body: cached.body,
            inputs,
            ...(wallClockS !== undefined && { wallClockS }),
            ...(isolation !== undefined && { isolation }),
            ...(deps !== undefined && { deps }),
            resourceLimits: overrides,
            image: this.#tier2Image,
            sandbox,
            ctxHandler,
          });
        }
        const pool = await this.#ensurePool();
        return pool.invoke({
          taskId,
          skillName: skill.name,
          body: cached.body,
          inputs,
          ...(wallClockS !== undefined && { wallClockS }),
          ...(isolation !== undefined && { isolation }),
          ...(deps !== undefined && { deps }),
          ctxHandler,
        });
      }
      default: {
        const _exhaustive: never = skill.tier;
        throw new Error(`unhandled skill tier: ${_exhaustive as string}`);
      }
    }
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
    const schedule = manifest.schedule ?? null;
    const insertParams: InsertSkillParams = {
      name: manifest.name,
      tier: manifest.tier,
      riskTier: "auto",
      effects: manifest.effects,
      schedule,
      scheduleNextRunAt: this.#computeScheduleNextRunAt(schedule),
      gitSha,
      lockfileHash: null,
      inputs: manifest.inputs,
      outputs: manifest.outputs ?? null,
    };

    const row = await this.#runInTx((tx) => this.#store.insertSkill(tx, insertParams));
    // Test-only fixed classifier log — bypasses the real classifier so tests
    // that don't care about risk-tier promotion can seed a skill cleanly.
    const testClassifierLog: ClassifierLog = {
      classifier_version: STUB_CLASSIFIER_VERSION,
      risk_tier: "auto",
      declared_effects: [],
      detected_effects: [],
      declared_secrets: [],
      declared_dependencies: [],
      validation_errors: [],
    };
    await this.#runInTx((tx) =>
      this.#store.insertDeploy(tx, {
        skillId: row.id,
        gitSha,
        priorGitSha: null,
        riskTier: "auto",
        status: "live",
        classifierLog: testClassifierLog,
      }),
    );

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

  /**
   * Mirror the bare repo's `refs/heads/main` to its configured `origin` after
   * a successful `register` / `approveDeploy` / `rollback`. Without this, the
   * local bare repo's main advances but the remote stays stale, and any
   * Daytona-backed coding task cloning from the remote (see
   * `design/sandbox.md` → git-remote transport) operates on an outdated
   * skill set.
   *
   * Non-blocking failure: if the push fails (network blip, lease check
   * failed, credentials revoked), the local register is *still* the truth.
   * We log a warning and let the next register reconcile, or the operator
   * run `git -C $COGMO_SKILLS_PATH push origin main` manually. Throwing
   * here would force a rollback of the DB transaction that already committed
   * — strictly worse than eventual consistency.
   *
   * Concurrency model: `register` is the only legitimate writer of remote
   * main. `force` is opt-in for `rollback` (which intentionally rewrites
   * history); register/approve use fast-forward push which fails clearly
   * if the remote has somehow drifted.
   */
  async #mirrorMainToRemote(
    newSha: string,
    options?: { force: { expectedRemoteSha: string } },
  ): Promise<void> {
    const repoPath = this.#requireRepoPath("mirrorMainToRemote");

    const remoteUrl = await readOriginUrl(repoPath);
    if (!remoteUrl) {
      log.warn(
        { newSha, repoPath },
        "skills bare repo has no `origin` — skipping remote mirror (configure via `cogmo migrate-skills-remote`)",
      );
      return;
    }

    // HTTPS URLs need credential helper; SSH URLs use ssh-agent / deploy keys.
    // We only resolve the GitHub identity for HTTPS to avoid pulling a
    // possibly-missing secret on SSH-only setups.
    let pat: string | null = null;
    if (remoteUrl.startsWith("https://")) {
      const identity = await this.#runInTx((tx) =>
        resolveGitHubIdentity(tx, this.#secretsStore, DEFAULT_GITHUB_IDENTITY_NAME),
      );
      if (identity.isOk()) pat = identity.value.pat;
    }

    const args = ["-C", repoPath, "push"];
    if (options?.force) {
      args.push(`--force-with-lease=refs/heads/main:${options.force.expectedRemoteSha}`);
    }
    args.push(remoteUrl, `${newSha}:refs/heads/main`);

    try {
      if (pat) {
        await withGitAskpass(pat, (env) => runGit(args, env));
      } else {
        await runGit(args);
      }
      log.info({ newSha, remoteUrl }, "mirrored skills main to remote");
    } catch (e) {
      log.warn(
        { newSha, remoteUrl, error: (e as Error).message },
        "skills remote mirror push failed; local state is authoritative — retry with `git -C $COGMO_SKILLS_PATH push origin main`",
      );
    }
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
    if (row.lockfileHash !== null) {
      // Lockfile presence is invariant with `row.lockfileHash != null` —
      // register persists the hash atomically with the gitSha, so a row
      // with a hash always has a committed lockfile. A missing/empty
      // read here means the repo + DB drifted (manual git tampering,
      // partial restore, ...) — surface it loudly.
      const snapshot = await readLockfileAtSha(this.#skillsRepoPath, row.gitSha);
      if (snapshot.isErr()) {
        throw new Error(
          `lockfile for skill '${row.name}' at ${row.gitSha} is ${snapshot.error.kind} — repo and DB are out of sync (skills.lockfile_hash=${row.lockfileHash})`,
        );
      }
      entry.lockfileContents = snapshot.value.contents;
    }
    this.#sourceCache.set(key, entry);
    return entry;
  }

  #validateOutput(
    cached: SkillSourceCacheEntry,
    output: unknown,
    skillName: string,
  ): string | null {
    if (cached.manifest.outputs === undefined) return null;
    // Lazy-compile per skill source — first invoke pays the cost, subsequent
    // invokes reuse the cached validator on the entry.
    if (cached.outputsValidator === undefined) {
      cached.outputsValidator = this.#ajv.compile(
        cached.manifest.outputs as Record<string, unknown>,
      );
    }
    const validator = cached.outputsValidator;
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
    lockfile: { hash: string; contents: string } | null;
  }): RegisterResult {
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
      const inputsValidator = this.#compileInputsValidator(manifest, "register-warm");
      this.#sourceCache.set(cacheKey(name, branchSha), {
        manifest,
        body,
        inputsValidator,
        ...(lockfile && { lockfileContents: lockfile.contents }),
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
      ...(lockfile && { lockfileContents: lockfile.contents }),
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

/**
 * `invoke` was called with a name that doesn't resolve to a skills row.
 * Discriminated via `instanceof` rather than substring matching against
 * `error.message` — call sites (the cron-fire-handler is the only one
 * today) translate it into their own skipped-result reason without
 * coupling to message wording.
 */
export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`skill not found: ${name}`);
    this.name = "SkillNotFoundError";
  }
}

/**
 * `invoke` was called on a row whose `disabled = true`. Same rationale as
 * {@link SkillNotFoundError}: `instanceof` discrimination, not string match.
 */
export class SkillDisabledError extends Error {
  constructor(name: string) {
    super(`skill is disabled: ${name}`);
    this.name = "SkillDisabledError";
  }
}

/**
 * `invoke` was called on a `tier: container` skill but no sandbox is wired
 * (e.g. `SANDBOX_RUNTIME` unset in the deployment). Permanent
 * misconfiguration — won't self-heal between retry attempts. The
 * cron-fire-handler discriminates this via `instanceof` to short-circuit
 * the retry budget into a `skipped: sandbox_unavailable` result, same
 * shape as {@link InputValidationError}'s `invalid_inputs` skip.
 */
export class SandboxUnavailableError extends Error {
  constructor(name: string) {
    super(`skill '${name}' is tier=container but no sandbox is configured (set SANDBOX_RUNTIME)`);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * `runner.invoke` recovered an existing run row whose `recovery_point` is
 * still `started`. Two situations produce this state and the runner can't
 * tell them apart from the row alone:
 *
 *   1. **Crashed mid-execute.** Prior attempt died after the INSERT but
 *      before the executed-transition wrote back. No worker is doing the
 *      work — the row is an orphan and the caller can retry once
 *      operators clear it (or the future `idempotent_invocation: true`
 *      manifest flag opts into optimistic re-execute).
 *   2. **Concurrent in-flight.** Another worker is actively executing
 *      this same key right now; the bus-dedup window was crossed and the
 *      retry landed on a live row. No crash, just contention.
 *
 * The conservative default in both cases is to refuse re-execution and
 * surface a typed error: re-executing case (1) is a recovery, but in
 * case (2) it would double-fire side effects (ctx.memory.write, outbound
 * HTTP, file writes) while the original is still in flight. The Stripe
 * pattern this implements takes the same posture — see
 * brandur.org/idempotency-keys → "Resumed transactions."
 *
 * Carries the run `runId` so operators can inspect. Discriminating
 * crash from concurrency at runtime would need a heartbeat (e.g.
 * `recovery_point='started' AND created_at < now() - interval 'N min'`);
 * deferred until either failure mode shows up in practice.
 */
export class SkillInflightError extends Error {
  readonly runId: string;
  constructor(name: string, runId: string) {
    super(
      `skill '${name}' has an in-flight run (id=${runId}) — prior attempt may have crashed mid-execute or another worker is currently executing`,
    );
    this.name = "SkillInflightError";
    this.runId = runId;
  }
}

/**
 * Rebuild the public `SkillRunResult` shape from the four fields the
 * `finished` row carries. Centralised so the three return sites (cached
 * replay + new-success + new-error) stay byte-identical and downstream
 * callers can rely on the same shape regardless of which path produced it.
 */
function reconstructFinishedResult(
  runId: string,
  status: SkillRunStatus,
  output: unknown | null,
  error: string | null,
): SkillRunResult {
  if (status === "success") {
    return {
      runId,
      status: "success",
      ...(output !== null && { output }),
    };
  }
  return {
    runId,
    status: "error",
    ...(error !== null && { error }),
  };
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
