import { PGlite } from "@electric-sql/pglite";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as codingSchema from "../agent/coding/store/schema.js";
import * as pipelineSchema from "../agent/pipeline/store/schema.js";
import * as agentSchema from "../agent/store/schema.js";
import { type Database, type Transactor, transactor } from "../db/index.js";
import * as mcpSchema from "../mcp/store/schema.js";
import * as sandboxSchema from "../sandbox/store/schema.js";
import * as secretsSchema from "../secrets/store/schema.js";
import * as skillsSchema from "../skills/store/schema.js";
import * as transportSchema from "../transport/store/schema.js";
import * as webSchema from "../web/store/schema.js";

const schema = {
  ...agentSchema,
  ...transportSchema,
  ...secretsSchema,
  ...sandboxSchema,
  ...codingSchema,
  ...pipelineSchema,
  ...skillsSchema,
  ...mcpSchema,
  ...webSchema,
};

/**
 * Boot an in-memory PGlite instance with the full schema applied.
 *
 * Returns:
 * - `db` — the Drizzle handle, for direct test setup like `truncateAll`
 *   or seeding rows that don't go through a store.
 * - `tx` — a `Transactor` derived from `db`, ready to hand to store
 *   constructors. Stores never see `db` itself.
 * - `close` — releases the PGlite client.
 */
export async function createTestDatabase(): Promise<{
  db: Database;
  tx: Transactor;
  close: () => Promise<void>;
}> {
  // PGlite bundles PostgreSQL 18, which provides `uuidv7()` in core — the same
  // function the schema's PK default calls and the same major the dev/prod
  // `pgvector/pgvector:pg18` image runs, so no extension is needed here.
  const client = new PGlite();

  const db = drizzle({ client, schema });

  // biome-ignore lint/suspicious/noExplicitAny: pushSchema expects PgDatabase<any>
  const { apply } = await pushSchema(schema, db as any);
  await apply();

  return {
    db,
    tx: transactor(db),
    close: () => client.close(),
  };
}

/** Truncate all public tables. */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(sql`
    DO $$ DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);
}
