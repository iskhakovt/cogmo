/**
 * One-shot migration: reclassify a Hindsight bank's existing memories
 * through the Observer pipeline so they pick up compartment + trust tags.
 *
 * Sequence:
 *   1. Paginate `listMemories(bankId)` to read every memory.
 *   2. Hand the materialised list to the injected `writeBackup` so the
 *      caller can persist it before any destructive step runs.
 *   3. Stage each memory into `pending_memories` with `source: "migration"`.
 *   4. `clearBankMemories(bankId)` to wipe the existing untagged rows.
 *
 * The next `conversation/idle` Observer run drains the staged rows
 * through the same classifier the live retain path uses.
 *
 * If `writeBackup` throws, no destructive step has run and Hindsight is
 * still intact. If staging or clear fails after backup, the backup is
 * the recovery substrate.
 */

import { z } from "zod";
import { logger } from "../../logger.js";
import type { AgentStore } from "../store/index.js";

const PAGE_SIZE = 100;

const RawMemorySchema = z.object({
  content: z.string(),
  context: z.string().nullable().optional(),
});

export interface RawBankMemory {
  content: string;
  context: string | null;
}

export interface ListMemoriesPage {
  items: ReadonlyArray<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}

export interface MigrationDeps {
  /** Read a page of memories from the Hindsight bank. */
  listMemories: (
    bankId: string,
    opts: { limit: number; offset: number },
  ) => Promise<ListMemoriesPage>;
  /** Wipe every memory in the bank, preserving the bank profile. */
  clearBankMemories: (bankId: string) => Promise<void>;
  agentStore: Pick<AgentStore, "bulkStagePendingMemories">;
  /** Persist a pre-clear snapshot. Must succeed before staging or clear runs. */
  writeBackup: (rows: ReadonlyArray<RawBankMemory>) => Promise<void>;
}

export interface MigrationResult {
  migrated: number;
}

export async function migrateUntaggedMemories(
  bankId: string,
  deps: MigrationDeps,
): Promise<MigrationResult> {
  const rows = await readBank(bankId, deps.listMemories);

  if (rows.length === 0) {
    logger.info({ bankId }, "migration: bank empty — nothing to do");
    await deps.writeBackup([]);
    return { migrated: 0 };
  }

  logger.info({ bankId, count: rows.length }, "migration: writing backup");
  await deps.writeBackup(rows);

  logger.info({ bankId, count: rows.length }, "migration: staging into pending_memories");
  await deps.agentStore.bulkStagePendingMemories(
    rows.map((row) => ({
      userId: bankId,
      content: row.content,
      ...(row.context !== null && { context: row.context }),
      source: "migration",
    })),
  );

  logger.info({ bankId }, "migration: clearing Hindsight bank");
  await deps.clearBankMemories(bankId);

  logger.info({ bankId, migrated: rows.length }, "migration complete");
  return { migrated: rows.length };
}

async function readBank(
  bankId: string,
  listMemories: MigrationDeps["listMemories"],
): Promise<RawBankMemory[]> {
  const out: RawBankMemory[] = [];
  let offset = 0;
  while (true) {
    const page = await listMemories(bankId, { limit: PAGE_SIZE, offset });
    if (page.items.length === 0) break;

    for (const item of page.items) {
      const parsed = RawMemorySchema.parse(item);
      out.push({ content: parsed.content, context: parsed.context ?? null });
    }

    offset += page.items.length;
    if (offset >= page.total) break;
  }
  return out;
}
