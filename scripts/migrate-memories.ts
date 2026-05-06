#!/usr/bin/env tsx
/**
 * Reclassify a Hindsight bank's existing memories so they pick up
 * compartment + trust tags assigned by the Observer pipeline.
 *
 * Usage:
 *   pnpm tsx scripts/migrate-memories.ts <bankId>
 *
 * Requires:
 *   DATABASE_URL  — PostgreSQL connection (default: postgresql://cogmo@localhost/cogmo)
 *   HINDSIGHT_URL — Hindsight server (default: http://localhost:8080)
 *
 * Output:
 *   Backup JSON written to .dev/memory-backups/<bankId>-<iso>.json before
 *   any destructive operation. Keep it until you've verified the
 *   re-classified memories look right after the next conversation idle.
 *
 * Partial-failure recovery:
 *   Sequence is stage → clear, in that order. If `clearBankMemories`
 *   throws after staging succeeds, the bank still has the originals AND
 *   `pending_memories` carries duplicates of the same content. The next
 *   Observer drain produces tagged copies on top of the untagged
 *   originals — duplicate, not lost. Recovery: rerun the script (it'll
 *   stage another set, but the backup file shows the canonical
 *   pre-migration state) or fix the bank manually using the JSON backup
 *   as the source of truth. The reverse ordering (clear before stage)
 *   would leak data on partial failure — the backup file would be the
 *   only substrate.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, createConfig, HindsightClient, sdk } from "@vectorize-io/hindsight-client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { z } from "zod";
import {
  migrateUntaggedMemories,
  type RawBankMemory,
} from "../src/agent/evolution/migrate-untagged-memories.js";
import { DrizzleAgentStore } from "../src/agent/store/index.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://cogmo@localhost/cogmo";
const HINDSIGHT_URL = process.env.HINDSIGHT_URL ?? "http://localhost:8080";
const BACKUP_DIR = ".dev/memory-backups";

async function main() {
  const bankId = process.argv[2];
  if (!bankId) {
    console.error("Usage: pnpm tsx scripts/migrate-memories.ts <bankId>");
    process.exit(1);
  }

  const db = drizzle({ connection: DATABASE_URL });
  await ensureSchemaReady(db);
  const agentStore = new DrizzleAgentStore(db);
  const hindsight = new HindsightClient({ baseUrl: HINDSIGHT_URL });
  const sdkClient = createClient(createConfig({ baseUrl: HINDSIGHT_URL }));

  mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = join(
    BACKUP_DIR,
    `${bankId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );

  console.log(`Migrating bank "${bankId}" — Hindsight ${HINDSIGHT_URL}`);
  console.log(`Backup will be written to ${backupPath}`);

  const writeBackup = async (rows: ReadonlyArray<RawBankMemory>) => {
    writeFileSync(backupPath, JSON.stringify(rows, null, 2));
    console.log(`Wrote ${rows.length} memories to backup at ${backupPath}`);
  };

  const result = await migrateUntaggedMemories(bankId, {
    listMemories: (id, opts) => hindsight.listMemories(id, opts),
    clearBankMemories: async (id) => {
      const res = await sdk.clearBankMemories({
        client: sdkClient,
        path: { bank_id: id },
      });
      if (res.error) {
        throw new Error(`clearBankMemories failed: ${JSON.stringify(res.error)}`);
      }
    },
    agentStore,
    writeBackup,
  });

  console.log(`\nMigrated ${result.migrated} memories — staged in pending_memories.`);
  console.log("Trigger any conversation/idle to drain them through the Observer classifier.");

  await db.$client.end();
}

const SchemaProbeRow = z.object({ present: z.boolean() });

async function ensureSchemaReady(db: ReturnType<typeof drizzle>): Promise<void> {
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'pending_memories'
    ) AS present
  `);
  const parsed = z.array(SchemaProbeRow).parse(result);
  if (parsed[0]?.present !== true) {
    console.error(
      "Error: pending_memories table not found. Run `pnpm db:migrate` before this script.",
    );
    await db.$client.end();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
