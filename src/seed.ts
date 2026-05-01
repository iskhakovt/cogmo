import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { DrizzleAgentStore } from "./agent/store/index.js";
import * as schema from "./db/schemas.js";
import { logger } from "./logger.js";
import { seedDefaults } from "./setup/seed.js";
import { DrizzleTransportStore } from "./transport/store/index.js";

/**
 * Seed the database with default data for single-user deployment.
 *
 * Idempotent — safe to run multiple times.
 * Creates: user, profile, direct channel, wildcard identity.
 *
 * Only requires DATABASE_URL — no other env vars needed. Reads
 * `process.env` directly (no `env.ts` import) so the seed entrypoint
 * stays minimal: an operator running `cogmo seed` shouldn't need to
 * supply the full runtime infra env (HINDSIGHT_URL, INNGEST_BASE_URL,
 * etc.) that `env.ts` validates.
 */
export async function seed(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://cogmo@localhost/cogmo";
  // Mirror `db/index.ts`'s NOTICE handling so seed-time `relation already
  // exists` chatter doesn't dump raw notice objects to stdout via the
  // driver's default console.log.
  const client = postgres(databaseUrl, {
    onnotice: (n) => logger.trace({ pgNotice: n }, "postgres notice"),
  });
  const db = drizzle({ client, schema });

  try {
    await migrate(db, { migrationsFolder: "./migrations" });
    logger.info("migrations applied");

    const agentStore = new DrizzleAgentStore(db);
    const transportStore = new DrizzleTransportStore(db);

    await seedDefaults(agentStore, transportStore);
    logger.info("seed complete");
  } finally {
    await db.$client.end();
  }
}
