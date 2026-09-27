import type { Sql } from "postgres";
import type { AgentStore } from "../agent/store/index.js";
import { withBootstrapLock } from "../db/bootstrap-lock.js";
import type { Database, Transactor } from "../db/index.js";
import { migratePerFile } from "../db/migrate-per-file.js";
import { logger } from "../logger.js";
import type { TransportStore } from "../transport/store/index.js";
import { applyReset, type ResetScope } from "./reset.js";
import { seedDefaults } from "./seed.js";

export interface MigrateAndSeedDeps {
  /** The client `db` runs on; the bootstrap lock holds one of its connections. */
  sql: Sql;
  db: Database;
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: TransportStore;
}

/**
 * Apply pending migrations, run `reset` when given, and seed the default user,
 * profile and fixed channels, all under the bootstrap lock. Shared by
 * `cogmo seed` and `cogmo setup`.
 */
export async function migrateAndSeed(
  deps: MigrateAndSeedDeps,
  args: { reset: ResetScope | null },
): Promise<{ userId: string; profileId: string }> {
  return withBootstrapLock(deps.sql, async () => {
    await migratePerFile(deps.db, { migrationsFolder: "./migrations" });
    logger.info("migrations applied");
    if (args.reset !== null) await applyReset(args.reset, { db: deps.db });
    return seedDefaults(deps.runInTx, deps.agentStore, deps.transportStore);
  });
}
