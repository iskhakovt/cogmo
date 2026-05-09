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
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { AgentStore } from "../store/index.js";

const PAGE_SIZE = 100;

/**
 * Hindsight's `listMemories` returns each unit with `text` (the
 * extracted fact) and `context` (empty string when absent — not
 * null). The earlier shape of this schema parsed `content`, which
 * never matched a real listMemories response and made this
 * migration silently unrunnable against a live bank — caught when
 * adding the integration test alongside `backfill-profile-class.ts`.
 *
 * **Acknowledged loss**: this migration drops the source memory's
 * `date` field. The Observer pipeline classifies via
 * `pending_memories` → `retainBatch`, and `RetainBatchItem.timestamp`
 * defaults to "now" on re-retain. Migrated facts therefore stamp as
 * fresh-today on Hindsight's temporal index. Cogmo's agent has no
 * temporal query surface today (no time-window recall, no scheduled
 * "what happened" cron), so this is latent rather than active —
 * earned-its-keep when (a) such a feature ships AND (b) the migrate
 * path runs on a bank with date-sensitive legacy facts. Plumbing
 * `date` through pending_memories needs a new
 * `original_timestamp` column + threading on `bulkStagePendingMemories`
 * / `getPendingMemories` / `ClassifierInput` / `buildRetainItems`;
 * defer until there's a consumer.
 */
const RawMemorySchema = z.object({
  text: z.string(),
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
  runInTx: Transactor;
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
  await deps.runInTx((tx) =>
    deps.agentStore.bulkStagePendingMemories(
      tx,
      rows.map((row) => ({
        userId: bankId,
        content: row.content,
        ...(row.context !== null && { context: row.context }),
        source: "migration",
      })),
    ),
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
      // Empty-string context is Hindsight's "no context" — normalise
      // to null so downstream `bulkStagePendingMemories` drops the
      // field instead of stamping a literal "" into pending_memories.
      const context =
        parsed.context !== undefined && parsed.context !== null && parsed.context.length > 0
          ? parsed.context
          : null;
      out.push({ content: parsed.text, context });
    }

    offset += page.items.length;
    if (offset >= page.total) break;
  }
  return out;
}
