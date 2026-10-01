import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { LockfileCompiler } from "../deps.js";
import type { SkillSourceCache } from "../source-cache.js";
import type { SkillRunIdentity, SkillStore } from "../store/index.js";

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
