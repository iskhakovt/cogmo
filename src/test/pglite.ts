import { PGlite } from "@electric-sql/pglite";
import { pg_uuidv7 } from "@electric-sql/pglite/pg_uuidv7";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as codingSchema from "../agent/coding/store/schema.js";
import * as agentSchema from "../agent/store/schema.js";
import type { Database } from "../db/index.js";
import * as mcpSchema from "../mcp/store/schema.js";
import * as sandboxSchema from "../sandbox/store/schema.js";
import * as secretsSchema from "../secrets/store/schema.js";
import * as skillsSchema from "../skills/store/schema.js";
import * as transportSchema from "../transport/store/schema.js";

const schema = {
  ...agentSchema,
  ...transportSchema,
  ...secretsSchema,
  ...sandboxSchema,
  ...codingSchema,
  ...skillsSchema,
  ...mcpSchema,
};

/**
 * Boot an in-memory PGlite instance with the full schema applied.
 * Returns the Drizzle db and a cleanup function.
 */
export async function createTestDatabase(): Promise<{
  db: Database;
  close: () => Promise<void>;
}> {
  const client = new PGlite({ extensions: { pg_uuidv7 } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS pg_uuidv7;");
  // pg_uuidv7 exposes uuid_generate_v7(); our schema uses uuidv7() — alias it
  await client.exec(
    "CREATE FUNCTION uuidv7() RETURNS uuid LANGUAGE sql AS $$ SELECT uuid_generate_v7() $$;",
  );

  const db = drizzle({ client, schema });

  // biome-ignore lint/suspicious/noExplicitAny: pushSchema expects PgDatabase<any>
  const { apply } = await pushSchema(schema, db as any);
  await apply();

  return {
    db,
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
