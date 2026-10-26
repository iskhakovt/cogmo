#!/usr/bin/env tsx
/**
 * Apply pending migrations the way boot does: `migratePerFile`, one
 * transaction per file, under the bootstrap advisory lock. A file that adds
 * an enum value commits before the file that uses it opens.
 *
 * Usage:
 *   pnpm db:migrate
 *
 * Requires:
 *   DATABASE_URL — PostgreSQL connection (default: postgresql://cogmo@localhost/cogmo)
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { bootstrapLock } from "../src/db/bootstrap-lock.js";
import { pinoNoticeHandler } from "../src/db/helpers.js";
import { migratePerFile } from "../src/db/migrate-per-file.js";
import * as schema from "../src/db/schemas.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://cogmo@localhost/cogmo";
const client = postgres(databaseUrl, { onnotice: pinoNoticeHandler });
const db = drizzle({ client, schema });

try {
  await bootstrapLock(client)(() => migratePerFile(db, { migrationsFolder: "./migrations" }));
  console.log("Migrations applied.");
} finally {
  await client.end();
}
