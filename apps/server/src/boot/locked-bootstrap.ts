/**
 * The boot steps that run under the bootstrap lock (`src/db/bootstrap-lock.ts`),
 * so concurrent `cogmo serve`, `cogmo seed` and `cogmo setup` runs apply them
 * one at a time.
 */

import type { CodingStore } from "../agent/coding/store/index.js";
import type { AgentStore } from "../agent/store/index.js";
import type { BootstrapLock } from "../db/bootstrap-lock.js";
import type { Database, Transactor } from "../db/index.js";
import { migratePerFile } from "../db/migrate-per-file.js";
import { logger } from "../logger.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { ensureFalImageDefaults, ensureWebChannel } from "../setup/seed.js";
import { bootstrapSkillsRepo, ensureSkillsCodingRepo } from "../skills/repo.js";
import type { TransportStore } from "../transport/store/index.js";
import { checkUuidv7 } from "./checks.js";

export interface PrepareDataLayerDeps {
  bootstrapLock: BootstrapLock;
  db: Database;
  runInTx: Transactor;
  codingStore: CodingStore;
}

/**
 * `bootstrapCore`'s locked step: apply migrations, check `uuidv7()`, and bring
 * the skills bare repo and its `coding_repos` row to their expected state.
 */
export async function prepareDataLayer(
  deps: PrepareDataLayerDeps,
  args: { skillsRepoPath: string },
): Promise<void> {
  await deps.bootstrapLock(async () => {
    await migratePerFile(deps.db, { migrationsFolder: "./migrations" });
    logger.info("database migrations applied");

    // Schema PKs default to `uuidv7()`. Verify the function is callable
    // before any code path inserts a row — a missing extension turns
    // every INSERT into a mid-turn `function does not exist` error
    // instead of a clear boot-time failure.
    await checkUuidv7(deps.db);

    // Bring the skills bare repo to its expected state on every boot —
    // idempotent. The pre-receive hook is rewritten unconditionally so a Cogmo
    // upgrade that tightens the policy takes effect on existing deployments.
    // See `design/skills.md` → Skill storage.
    const skillsRepo = await bootstrapSkillsRepo({ path: args.skillsRepoPath });
    if (skillsRepo.initialized) {
      logger.info({ path: skillsRepo.path }, "skills bare repo initialized");
    }

    // DB half of the skills-repo bootstrap: keep `coding_repos.skills.remote_url`
    // in sync with the bare repo's `origin`. Idempotent — inserts on first run,
    // updates on subsequent boots after the operator changes origin via the
    // wizard or `cogmo migrate-skills-remote`, no-ops when already in sync.
    // When the bare repo has no origin yet, the call returns `skipped_no_origin`
    // and `delegate_coding({ repo: "skills" })` will fail with a clear message
    // until the wizard/CLI runs.
    await ensureSkillsCodingRepo(
      { runInTx: deps.runInTx, codingStore: deps.codingStore },
      { skillsRepoPath: skillsRepo.path },
    );
  });
}

export interface SeedRuntimeDefaultsDeps {
  bootstrapLock: BootstrapLock;
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: TransportStore;
  secretsStore: SecretsStore;
}

/**
 * `bootstrapRuntime`'s locked step: seed the fal image catalog and the web
 * channel.
 */
export async function seedRuntimeDefaults(
  deps: SeedRuntimeDefaultsDeps,
  args: { userId: string; envFalApiKey?: string },
): Promise<void> {
  await deps.bootstrapLock(async () => {
    // Image gen catalog is DB-driven (image_providers + image_models). At boot
    // we seed the canonical fal catalog if a fal secret exists — handles both
    // wizard-driven setups and the legacy FAL_API_KEY env var path. The
    // catalog itself is loaded per-turn by `ImageToolsLoader`, so wizard / CLI
    // CRUD takes effect immediately without a restart; provider adapters are
    // memoized inside the loader so we only decrypt + construct each provider's
    // SDK client once per process.
    await ensureFalImageDefaults({
      runInTx: deps.runInTx,
      agentStore: deps.agentStore,
      secretsStore: deps.secretsStore,
      ...(args.envFalApiKey !== undefined && { envFalApiKey: args.envFalApiKey }),
    });

    // Provision the web channel before startChannels so its placeholder adapter
    // is matched (no "unknown channel type" warning). Idempotent + boot-time:
    // seedDefaults runs only under `cogmo setup` / `cogmo seed`, so this gives
    // existing deployments the channel on upgrade without re-running the wizard.
    await ensureWebChannel(deps.runInTx, deps.transportStore, args.userId);
  });
}
