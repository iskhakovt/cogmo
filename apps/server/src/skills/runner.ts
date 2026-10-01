import type { Result } from "neverthrow";
import { computeNextRun } from "../agent/scheduling/cron.js";
import type { Transactor } from "../db/index.js";
import { defaultSkillsImage } from "../env.js";
import { logger } from "../logger.js";
import type { SandboxClient } from "../sandbox/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { DefaultCtxHandlerOptions } from "./ctx-handler.js";
import {
  type DeregisterResult,
  deregisterSkill,
  type EnableResult,
  enableSkill,
} from "./deploy/activation.js";
import { approveDeploy, denyDeploy } from "./deploy/approve.js";
import type { DeployDeps } from "./deploy/deploy-deps.js";
import type { SkillDeployOrigin } from "./deploy/origin.js";
import { registerSkill } from "./deploy/register.js";
import type { RegisterResult } from "./deploy/register-result.js";
import { rollbackSkill } from "./deploy/rollback.js";
import { type LockfileCompiler, makeSandboxLockfileCompiler } from "./deps.js";
import { type InvokeDeps, invokeSkill } from "./invoke/invoke.js";
import type { SkillRunResult } from "./invoke/run-result.js";
import { LazyWarmPool, type WarmPoolSizing } from "./invoke/warm-pool.js";
import type { SkillInvokeRejection } from "./invoke-rejection.js";
import {
  type ListingDeps,
  listAllSkills,
  listSkills,
  listToolDefs,
  type SkillSummary,
  type SkillToolDef,
} from "./listing.js";
import type { SkillRunAs } from "./run-as.js";
import { type RegisterForTestsParams, seedSkillForTests } from "./seed-for-tests.js";
import { SkillSourceCache } from "./source-cache.js";
import type { SkillRow, SkillRunIdentity, SkillRunTrigger, SkillStore } from "./store/index.js";

export type {
  DeregisterResult,
  EnableResult,
} from "./deploy/activation.js";
export type { SkillActor, SkillDeployOrigin } from "./deploy/origin.js";
export type { RegisterResult } from "./deploy/register-result.js";
export type { SkillRunResult } from "./invoke/run-result.js";
export type { SkillSummary, SkillToolDef } from "./listing.js";
export type { RegisterForTestsParams } from "./seed-for-tests.js";

/**
 * Default tier-2 container image when the constructor doesn't override it.
 * Production wiring always passes `tier2Image:
 * env.COGMO_SKILLS_IMAGE`, so this default only matters for tests that
 * construct a runner without an explicit image AND actually invoke a
 * tier-container skill (the integration test does the latter — it overrides).
 * Shares the helper with `env.ts` so the two never drift.
 */
const DEFAULT_TIER2_IMAGE = defaultSkillsImage();

const log = logger.child({ component: "skills.runner" });

/**
 * Public contract for the skills runtime: the deploy pipeline (`register` /
 * `approveDeploy` / `denyDeploy` / `rollback`), activation (`deregister` /
 * `enable`), listing, and invocation. The interface is the boundary the CLI,
 * agent tool, and dynamic-tool registrar all depend on.
 */
export interface SkillRunner {
  /**
   * `origin` decides who a schedule the request puts live runs as.
   *
   * `signal` is checked at the start and just before the deploy transaction,
   * and the lockfile compile honours it throughout. An abort seen by then
   * stops the deploy: `register` rejects with the signal's reason, leaving
   * main and the branch as they were. It is not a wall-clock cap: work that
   * takes no signal (local git, the classifier, PyPI lookups) runs to its end
   * first. Once the transaction has started, an abort only cuts the mirror
   * push short.
   */
  register(opts: {
    branch: string;
    origin: SkillDeployOrigin;
    signal?: AbortSignal;
  }): Promise<RegisterResult>;
  /** A `user` origin is also recorded as the deploy's `approved_by`. */
  approveDeploy(opts: { pendingId: string; origin: SkillDeployOrigin }): Promise<RegisterResult>;
  denyDeploy(opts: { pendingId: string; reason?: string }): Promise<void>;
  rollback(opts: {
    name: string;
    toGitSha: string;
    origin: SkillDeployOrigin;
  }): Promise<RegisterResult>;
  /**
   * Soft-disable a skill. Idempotent on already-disabled rows (returns
   * `kind: "deregistered"` either way — soft-disable already supports
   * the no-op case at the store layer). A disabled schedule runs as no
   * one, so its run-as identity clears. See {@link DeregisterResult}.
   */
  deregister(opts: { name: string }): Promise<DeregisterResult>;
  /**
   * Re-activate a soft-disabled skill. Refuses if the skill was never live
   * at its current `gitSha` (denied-on-first-deploy case) — re-enabling
   * would otherwise smuggle un-approved code past the approval gate.
   * Idempotent: enabling an already-enabled skill returns `already_enabled`
   * rather than erroring. A schedule it puts live runs as `origin` says,
   * like a deploy's. See {@link EnableResult}.
   */
  enable(opts: { name: string; origin: SkillDeployOrigin }): Promise<EnableResult>;

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
    /** Who the run acts for: `ctx.user()`, and the services `ctx.memory` / `ctx.files` reach. */
    runAs: SkillRunAs;
  }): Promise<Result<SkillRunResult, SkillInvokeRejection>>;
}

export interface SkillRunnerOptions {
  store: SkillStore;
  runInTx: Transactor;
  secretsStore: SecretsStore;
  /** IANA timezone: `ctx.user().timezone`, and the zone manifest schedules fire in. */
  userTimezone: string;
  /** The install owner with the default profile — what an `owner` origin runs as. */
  defaultRunAs: SkillRunIdentity;
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
   * Named Docker volume that holds per-lockfile-hash skill virtualenvs.
   * Threaded into every tier-2 worker the pool spawns so populated
   * venvs persist across worker recycle + are shared across the pool.
   * Production wiring sets this from
   * `env.COGMO_SKILLS_DEPS_VOLUME`. Omit for tests / tier-1-only paths
   * that don't need the cache.
   */
  depsCacheVolumeName?: string;
  /**
   * Pool sizing overrides. Defaults from `DEFAULT_POOL_OPTIONS` are tuned
   * for personal scale (min=1, max=3, recycle every 500 tasks or 24h).
   * Tests can shrink to `min: 0` to avoid eager-spawning a worker on
   * `create()`.
   */
  poolOptions?: WarmPoolSizing;
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
  /**
   * The network `ctx.http` reaches, passed to every `DefaultCtxHandler`
   * the runner builds — so it covers both tiers, while a tier-2 skill's
   * own sockets stay on the real network. Omit in production for real DNS
   * and the global `fetch`. The allowlist and address checks run against
   * whatever this answers.
   *
   * Both halves or neither: a resolver alone would pass the address guard
   * on its own answer while the global `fetch` connects wherever the name
   * really points.
   */
  ctxHttp?: Required<Pick<DefaultCtxHandlerOptions, "resolveHost" | "fetch">>;
}

/**
 * The {@link SkillRunner} a deployment builds: wires one source cache, one
 * warm pool and the deploy and invoke use cases over the same store.
 */
export class SkillRunnerImpl implements SkillRunner {
  #deploy: DeployDeps;
  #invoke: InvokeDeps;
  #listing: ListingDeps;
  #warmPool: LazyWarmPool;

  private constructor(opts: SkillRunnerOptions) {
    const tier2Image = opts.tier2Image ?? DEFAULT_TIER2_IMAGE;
    // A shared deps-cache volume only makes sense when the sandbox
    // backend can honour uv's POSIX assumptions (hardlinks, atomic
    // rename, O_RDWR). Backends that advertise `per-sandbox` use
    // container-local /skill-venvs and pay a cold populate per worker;
    // omit the volume name regardless of what wiring passed in.
    const sandboxIncompatible = opts.sandbox?.capabilities.depsCacheSharing === "per-sandbox";
    const depsCacheVolumeName = sandboxIncompatible ? undefined : opts.depsCacheVolumeName;
    if (sandboxIncompatible && opts.depsCacheVolumeName !== undefined) {
      log.warn(
        {
          backend: opts.sandbox?.backendId,
          depsCacheVolumeName: opts.depsCacheVolumeName,
        },
        "ignoring depsCacheVolumeName — backend advertises depsCacheSharing: 'per-sandbox' (each sandbox uses ephemeral /skill-venvs)",
      );
    }
    const clock = opts.clock ?? (() => new Date());
    const sourceCache = new SkillSourceCache(opts.skillsRepoPath);
    this.#warmPool = new LazyWarmPool({
      image: tier2Image,
      depsCacheVolumeName,
      sizing: opts.poolOptions,
    });
    this.#deploy = {
      store: opts.store,
      runInTx: opts.runInTx,
      secretsStore: opts.secretsStore,
      defaultRunAs: opts.defaultRunAs,
      skillsRepoPath: opts.skillsRepoPath,
      sourceCache,
      // Explicit override wins; otherwise default to a sandbox-backed
      // compiler when the runtime has both a sandbox and a tier-2 image
      // (the cogmo-skills image carries `uv`). Tier-1-only deployments
      // fall through to undefined → presence + hash check only.
      lockfileCompiler:
        opts.lockfileCompiler ??
        (opts.sandbox
          ? makeSandboxLockfileCompiler({
              sandbox: opts.sandbox,
              image: tier2Image,
              ...(depsCacheVolumeName !== undefined && { depsCacheVolumeName }),
            })
          : undefined),
      // The first occurrence of the manifest's `schedule` after the current
      // clock tick, in `userTimezone`.
      scheduleNextRunAt: (schedule) =>
        schedule === null ? null : computeNextRun(schedule, opts.userTimezone, clock()),
    };
    this.#listing = { store: opts.store, runInTx: opts.runInTx, sourceCache };
    this.#invoke = {
      store: opts.store,
      runInTx: opts.runInTx,
      secretsStore: opts.secretsStore,
      userTimezone: opts.userTimezone,
      sourceCache,
      sandbox: opts.sandbox,
      warmPool: this.#warmPool,
      runtime: {
        pyodidePackageCacheDir: opts.pyodidePackageCacheDir,
        tier2Image,
        depsCacheVolumeName,
      },
      ctxHttp: opts.ctxHttp,
    };
  }

  static async create(opts: SkillRunnerOptions): Promise<SkillRunnerImpl> {
    // Pool init is deferred to first tier-2 invocation — cogmo serve
    // boots independently of sandbox availability. See `LazyWarmPool`.
    return new SkillRunnerImpl(opts);
  }

  /**
   * Dispose the warm pool; `cogmo serve` calls this on exit. Waits for a pool
   * start in flight and disposes what it produces; afterwards a tier-2 invoke
   * throws `tier-2 pool requested after shutdown`. Idempotent. Tier-1 workers
   * live for one call and need nothing here.
   */
  shutdown(): Promise<void> {
    return this.#warmPool.shutdown();
  }

  register(opts: {
    branch: string;
    origin: SkillDeployOrigin;
    signal?: AbortSignal;
  }): Promise<RegisterResult> {
    return registerSkill(this.#deploy, opts);
  }

  approveDeploy(opts: { pendingId: string; origin: SkillDeployOrigin }): Promise<RegisterResult> {
    return approveDeploy(this.#deploy, opts);
  }

  denyDeploy(opts: { pendingId: string; reason?: string }): Promise<void> {
    return denyDeploy(this.#deploy, opts);
  }

  rollback(opts: {
    name: string;
    toGitSha: string;
    origin: SkillDeployOrigin;
  }): Promise<RegisterResult> {
    return rollbackSkill(this.#deploy, opts);
  }

  deregister(opts: { name: string }): Promise<DeregisterResult> {
    return deregisterSkill(this.#deploy, opts);
  }

  enable(opts: { name: string; origin: SkillDeployOrigin }): Promise<EnableResult> {
    return enableSkill(this.#deploy, opts);
  }

  list(): Promise<readonly SkillSummary[]> {
    return listSkills(this.#listing);
  }

  listAll(): Promise<readonly SkillSummary[]> {
    return listAllSkills(this.#listing);
  }

  listToolDefs(): Promise<readonly SkillToolDef[]> {
    return listToolDefs(this.#listing);
  }

  invoke(opts: {
    name: string;
    inputs: unknown;
    trigger?: SkillRunTrigger;
    idempotencyKey?: string;
    runAs: SkillRunAs;
  }): Promise<Result<SkillRunResult, SkillInvokeRejection>> {
    return invokeSkill(this.#invoke, opts);
  }

  /** Seed a live skill without git or the classifier; see {@link RegisterForTestsParams}. */
  __registerForTests(params: RegisterForTestsParams): Promise<SkillRow> {
    return seedSkillForTests(this.#deploy, params);
  }
}
