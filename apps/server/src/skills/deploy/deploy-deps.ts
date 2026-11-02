import type { Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { SkillsCapabilities } from "../capabilities.js";
import type { LockfileCompiler, LockfileSnapshot } from "../deps.js";
import type { SkillSourceCache } from "../source-cache.js";
import type { SkillRunIdentity, SkillStore } from "../store/index.js";
import type {
  FillBuiltins,
  Tier1Packages,
  Tier1PackagesError,
  Tier1Probe,
} from "../worker-wasm/tier1.js";

/** What the deploy use cases (register, approve, rollback, enable) share. */
export interface DeployDeps {
  store: SkillStore;
  runInTx: Transactor;
  /** Resolves the GitHub identity the mirror push authenticates with. */
  secretsStore: SecretsStore;
  /** The install owner with the default profile — what an `owner` origin runs as. */
  defaultRunAs: SkillRunIdentity;
  /** The bare skills repo; unset on runners built for invoke-only tests. */
  skillsRepoPath: string | undefined;
  sourceCache: SkillSourceCache;
  /** Re-resolves a manifest's dependencies; unset degrades to presence + hash checks. */
  lockfileCompiler: LockfileCompiler | undefined;
  /**
   * The first occurrence of `schedule` after now, in the user's timezone, or
   * null when there is none — the all-or-none pair `(schedule, nextRunAt)`.
   */
  scheduleNextRunAt(schedule: string | null): Date | null;
  /** What this deployment enforces; the classifier reads it for the tier. */
  capabilities: SkillsCapabilities;
  /**
   * Tier 1's host side at register: the probe that load-tests native
   * built-ins under the boundary's flags, the fill of the cache it loads
   * from, and the resolver that fetches and publishes a lockfile's packages
   * so the first run pays no download.
   */
  tier1: {
    /** What register's PyPI lookups and downloads go through. */
    fetchImpl: typeof fetch;
    probe: Tier1Probe;
    fillBuiltins: FillBuiltins;
    packageCacheDir: string;
    resolvePackages(
      lockfile: LockfileSnapshot,
      signal?: AbortSignal,
    ): Promise<Result<Tier1Packages, Tier1PackagesError>>;
  };
}

/** The bare repo path, or a configuration error naming the method that needs it. */
export function requireRepoPath(deps: Pick<DeployDeps, "skillsRepoPath">, method: string): string {
  if (!deps.skillsRepoPath) {
    throw new Error(
      `SkillRunner.${method}: skillsRepoPath not configured — set SkillRunnerOptions.skillsRepoPath`,
    );
  }
  return deps.skillsRepoPath;
}

/** The ref `update-ref` compares against when `main` is unborn. */
export const ZERO_SHA = "0000000000000000000000000000000000000000";
