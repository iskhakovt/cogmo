import type { Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { SkillsCapabilities } from "../capabilities.js";
import type { LockfileCompiler, LockfileSnapshot } from "../deps.js";
import type { ImportedSchemas, SchemaImportError } from "../schema-import.js";
import type { SkillsRepo } from "../skill-files.js";
import type { SkillSourceCache } from "../source-cache.js";
import type { SkillRunIdentity, SkillStore } from "../store/index.js";
import type { SkillManifest } from "../types.js";
import type { FillBuiltins, SkillSchemaImportError, WasmProbe } from "../worker-wasm/wasm.js";

/** What the deploy use cases (register, approve, rollback, enable) share. */
export interface DeployDeps {
  store: SkillStore;
  runInTx: Transactor;
  /** Resolves the GitHub identity the mirror push authenticates with. */
  secretsStore: SecretsStore;
  /** The install owner with the default profile — what an `owner` origin runs as. */
  defaultRunAs: SkillRunIdentity;
  /** The bare skills repo; unset on runners built for invoke-only tests. */
  skillsRepo: SkillsRepo | undefined;
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
   * The container tier's schema import at register, or undefined when the
   * backend creates no session with no network: every container skill then
   * takes the legacy schema path, its frontmatter. Without the shared venv
   * volume (`installsDependencies` false), so does one with dependencies
   * (design/skills.md → Contracts).
   */
  containerSchemas:
    | {
        installsDependencies: boolean;
        importSchemas(
          source: {
            body: string;
            lockfile: LockfileSnapshot | null;
            resources: SkillManifest["resources"];
          },
          signal?: AbortSignal,
        ): Promise<Result<ImportedSchemas, SchemaImportError>>;
      }
    | undefined;
  /**
   * The wasm tier's host side at register: the probe that load-tests native
   * built-ins under the boundary's flags, the fill of the cache it loads
   * from, and the schema import, which fetches and publishes the skill's
   * packages, so the first run pays no download, and reads its models' JSON
   * Schemas in a child.
   */
  wasm: {
    /** What register's PyPI lookups and downloads go through. */
    fetchImpl: typeof fetch;
    probe: WasmProbe;
    fillBuiltins: FillBuiltins;
    packageCacheDir: string;
    importSchemas(
      source: {
        body: string;
        lockfile: LockfileSnapshot | null;
        resources: SkillManifest["resources"];
      },
      signal?: AbortSignal,
    ): Promise<Result<ImportedSchemas, SkillSchemaImportError>>;
  };
}

/** The bare repo, or a configuration error naming the method that needs it. */
export function requireRepo(deps: Pick<DeployDeps, "skillsRepo">, method: string): SkillsRepo {
  if (!deps.skillsRepo) {
    throw new Error(
      `SkillRunner.${method}: skillsRepoPath not configured — set SkillRunnerOptions.skillsRepoPath`,
    );
  }
  return deps.skillsRepo;
}

/** The ref `update-ref` compares against when `main` is unborn. */
export const ZERO_SHA = "0000000000000000000000000000000000000000";
