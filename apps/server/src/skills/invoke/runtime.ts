import type { Result } from "neverthrow";
import type { SandboxClient } from "../../sandbox/index.js";
import type { DefaultCtxHandler } from "../ctx-handler.js";
import type { LockfileSnapshot } from "../deps.js";
import type { SkillSourceCacheEntry } from "../source-cache.js";
import type { SkillRow, SkillTier } from "../store/index.js";
import type { SkillManifest } from "../types.js";
import { runOnSysboxContainer } from "../worker-sysbox/host.js";
import type { SysboxWorkerPool } from "../worker-sysbox/pool.js";
import type { InvokeResult } from "../worker-sysbox/worker.js";
import {
  DEFAULT_TIER1_MEMORY_MB,
  type RunOnWorkerResult,
  runOnWorker,
} from "../worker-wasm/host.js";
import type { Tier1Packages } from "../worker-wasm/tier1.js";
import type { Tier1PackagesError } from "../worker-wasm/wheel-cache.js";

/**
 * Translate a manifest's `resources` block into the partial `ResourceLimits`
 * the tier-2 host expects. Naming differs intentionally: skills declare
 * `cpu_shares` (integer 1-4) and `memory_mb` (megabytes), while the sandbox
 * speaks fractional `cpus` and `memory_bytes` — so this function owns the
 * conversion. Returns only fields the manifest set; the host fills the rest
 * from `DEFAULT_RESOURCE_LIMITS`.
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

/**
 * Whether a tier-2 skill runs on the warm pool. The pool runs every worker
 * at the default budget, so a skill declaring its own resources gets a
 * one-shot container instead.
 */
function runsOnPool(manifest: SkillManifest): boolean {
  const overrides = mapManifestResourceLimits(manifest.resources);
  return overrides.cpus === undefined && overrides.memory_bytes === undefined;
}

/** Where a run executes: the tier-1 isolate, the warm pool, or a one-shot container. */
export type SkillRuntime =
  | { kind: "wasm" }
  | { kind: "pool"; pool: SysboxWorkerPool }
  | { kind: "one_shot"; sandbox: SandboxClient };

/** A {@link SkillRuntime} before the warm pool is started. */
export type RuntimePlan =
  | Exclude<SkillRuntime, { kind: "pool" }>
  | { kind: "pool"; sandbox: SandboxClient };

/**
 * Where a run of this skill executes, or null for a container skill on a
 * deployment with no sandbox.
 */
export function planRuntime(
  tier: SkillTier,
  manifest: SkillManifest,
  sandbox: SandboxClient | undefined,
): RuntimePlan | null {
  if (tier === "wasm") return { kind: "wasm" };
  if (!sandbox) return null;
  return runsOnPool(manifest) ? { kind: "pool", sandbox } : { kind: "one_shot", sandbox };
}

/** How the runner's deployment configures the runtimes. */
export interface RuntimeConfig {
  /** Pyodide's package cache, the only place a tier-1 child loads built-ins from. */
  pyodidePackageCacheDir: string;
  /** The real path of the Pyodide distribution (`pyodideDistDir()`). */
  pyodideDistDir: string;
  /** Where tier-1 children's process-group records live while they run. */
  tier1ChildrenDir: string;
  /**
   * What a tier-1 child installs for a lockfile: the built-ins the package
   * cache holds and the lockfile's read-only wheel directory, fetched and
   * verified by the host when missing (`ensureTier1Packages`).
   */
  resolveTier1Packages(
    lockfile: LockfileSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<Result<Tier1Packages, Tier1PackagesError>>;
  /** Container image for one-shot tier-2 runs. */
  tier2Image: string;
  /** Named volume of per-lockfile venvs, when the sandbox can share one. */
  depsCacheVolumeName: string | undefined;
}

/**
 * Run the task on the runtime {@link planRuntime} chose. `packages` is what a
 * tier-1 child installs; the container runtimes ignore it.
 */
export async function dispatchToRuntime(
  config: RuntimeConfig,
  runtime: SkillRuntime,
  skill: SkillRow,
  cached: SkillSourceCacheEntry,
  inputs: unknown,
  ctxHandler: DefaultCtxHandler,
  taskId: string,
  packages: Tier1Packages,
): Promise<RunOnWorkerResult | InvokeResult> {
  const wallClockS = cached.manifest.resources?.wall_clock_s;
  const task = {
    taskId,
    skillName: skill.name,
    body: cached.body,
    inputs,
    ...(wallClockS !== undefined && { wallClockS }),
    ctxHandler,
  };
  if (runtime.kind === "wasm") {
    return runOnWorker({
      ...task,
      packageCacheDir: config.pyodidePackageCacheDir,
      packages,
      pyodideDistDir: config.pyodideDistDir,
      childrenDir: config.tier1ChildrenDir,
      memoryMb: cached.manifest.resources?.memory_mb ?? DEFAULT_TIER1_MEMORY_MB,
    });
  }
  const isolation = cached.manifest.isolation;
  // Invariant: skill.lockfileHash != null ⇒ cached.lockfile set.
  let deps: { lockfileHash: string; lockfileContents: string } | undefined;
  if (skill.lockfileHash !== null) {
    if (cached.lockfile === undefined) {
      throw new Error(
        `invariant: skill '${skill.name}' has lockfile_hash but cache missing lockfile`,
      );
    }
    deps = { lockfileHash: cached.lockfile.hash, lockfileContents: cached.lockfile.contents };
  }
  const containerTask = {
    ...task,
    ...(isolation !== undefined && { isolation }),
    ...(deps !== undefined && { deps }),
  };
  if (runtime.kind === "pool") return runtime.pool.invoke(containerTask);
  return runOnSysboxContainer({
    ...containerTask,
    ...(config.depsCacheVolumeName !== undefined && {
      depsCacheVolumeName: config.depsCacheVolumeName,
    }),
    resourceLimits: mapManifestResourceLimits(cached.manifest.resources),
    image: config.tier2Image,
    sandbox: runtime.sandbox,
  });
}
