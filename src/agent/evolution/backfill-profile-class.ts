/**
 * One-shot backfill: stamp existing Hindsight memories with
 * `profile_class:<tag>` tags so opting profiles into `profileClasses`
 * scoping doesn't blank recall on pre-feature rows.
 *
 * Sequence (option B from the design discussion — re-retain with
 * augmented tags, no classifier):
 *   1. Paginate `listMemories(bankId)` to read every memory plus its
 *      existing tags / timestamp / metadata / context — everything
 *      needed to re-retain identically.
 *   2. Hand the materialised list to `writeBackup` so the caller has
 *      a recovery substrate before any destructive step runs.
 *   3. Build `MemoryItemInput[]` carrying the row's ORIGINAL tags +
 *      timestamp + metadata + context, plus one `profile_class:<tag>`
 *      entry per `classTags` argument. Rows that already carry a
 *      `profile_class:*` tag pass through unchanged (idempotent).
 *   4. `clearBankMemories(bankId)` to wipe the un-tagged originals.
 *   5. `retainBatch(bankId, items)` to write the augmented copies.
 *
 * Idempotence: re-running on a bank where every row already has a
 * `profile_class:*` tag is a no-op — `classified` returns 0 and the
 * function reports `skipped === total`. Recovery from partial failure
 * after step 4: the backup written in step 2 is the source of truth.
 *
 * This intentionally does NOT go through the Observer drain (the
 * `migrate-untagged-memories.ts` path); re-classifying via the LLM
 * would risk drifting an already-correct compartment / trust label,
 * and the goal here is purely to add a new tag dimension on top of
 * existing classifications.
 */

import { z } from "zod";
import { logger } from "../../logger.js";

const PAGE_SIZE = 100;

/**
 * Permissive parser for an item from `HindsightClient.listMemories`.
 * The SDK returns `Record<string, unknown>` per item — actual fields
 * are server-defined.
 *
 * Hindsight's read shape and write shape disagree on field names:
 *   - listMemories items expose `text` (the extracted fact) and
 *     `date` (when the fact occurred / was mentioned).
 *   - retainBatch's `MemoryItemInput` takes `content` and `timestamp`.
 * We read the read-side names here and translate at the retain
 * boundary. `context` comes back as `""` (empty string) when absent
 * — treat that as null. `metadata` (optional) carries any
 * `{source: "conversation"|"live_retain"|"migration"}`-style stamp
 * the original retain set; we round-trip it so the post-backfill
 * memory keeps the same provenance. Unknown fields are tolerated
 * (`passthrough`) because the response carries server-stamped extras
 * (`id`, `chunk_id`, `mentioned_at`, etc.) we don't propagate.
 */
const RawBankMemorySchema = z
  .object({
    text: z.string(),
    context: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    date: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export interface RawBankMemory {
  content: string;
  context: string | null;
  tags: string[];
  timestamp: string | null;
  metadata: Record<string, string>;
}

export interface ListMemoriesPage {
  items: ReadonlyArray<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}

/**
 * Subset of `MemoryItemInput` we emit on retain — duplicated here so
 * the pure function doesn't depend on the Hindsight SDK's exact type
 * (and so the unit tests can assert against a stable shape).
 */
export interface RetainItem {
  content: string;
  tags: string[];
  context?: string;
  timestamp?: string;
  metadata?: Record<string, string>;
}

export interface BackfillDeps {
  /** Read a page of memories. */
  listMemories: (
    bankId: string,
    opts: { limit: number; offset: number },
  ) => Promise<ListMemoriesPage>;
  /** Wipe every memory in the bank. */
  clearBankMemories: (bankId: string) => Promise<void>;
  /** Re-ingest the augmented rows. */
  retainBatch: (bankId: string, items: ReadonlyArray<RetainItem>) => Promise<void>;
  /** Persist a pre-clear snapshot. Must succeed before any destructive step. */
  writeBackup: (rows: ReadonlyArray<RawBankMemory>) => Promise<void>;
}

export interface BackfillOpts {
  /**
   * Class tag values to add to un-classed rows. Each value `v` becomes
   * a `profile_class:<v>` tag on every un-classed memory. Must be
   * non-empty — passing zero classes would mean "do nothing" and
   * should be a parser error at the caller, not a silent no-op here.
   */
  classTags: ReadonlyArray<string>;
}

export interface BackfillResult {
  /** Total memories read from the bank. */
  total: number;
  /** Rows we re-retained with new `profile_class:*` tags appended. */
  classified: number;
  /** Rows that already carried a `profile_class:*` tag — passed through unchanged. */
  skipped: number;
}

export async function backfillProfileClass(
  bankId: string,
  deps: BackfillDeps,
  opts: BackfillOpts,
): Promise<BackfillResult> {
  if (opts.classTags.length === 0) {
    throw new Error("backfillProfileClass: classTags must be non-empty");
  }

  const rows = await readBank(bankId, deps.listMemories);

  if (rows.length === 0) {
    logger.info({ bankId }, "backfill: bank empty — nothing to do");
    await deps.writeBackup([]);
    return { total: 0, classified: 0, skipped: 0 };
  }

  logger.info({ bankId, count: rows.length }, "backfill: writing backup");
  await deps.writeBackup(rows);

  const newTags = opts.classTags.map((c) => `profile_class:${c}`);
  let classified = 0;
  let skipped = 0;

  const items: RetainItem[] = rows.map((row) => {
    const alreadyClassed = row.tags.some((t) => t.startsWith("profile_class:"));
    const tags = alreadyClassed ? [...row.tags] : [...row.tags, ...newTags];
    if (alreadyClassed) skipped++;
    else classified++;
    return {
      content: row.content,
      tags,
      ...(row.context !== null && { context: row.context }),
      ...(row.timestamp !== null && { timestamp: row.timestamp }),
      ...(Object.keys(row.metadata).length > 0 && { metadata: row.metadata }),
    };
  });

  if (classified === 0) {
    logger.info(
      { bankId, total: rows.length },
      "backfill: every row already carries profile_class:* — no-op",
    );
    return { total: rows.length, classified: 0, skipped };
  }

  logger.info(
    { bankId, total: rows.length, classified, skipped },
    "backfill: clearing Hindsight bank",
  );
  await deps.clearBankMemories(bankId);

  logger.info({ bankId, count: items.length }, "backfill: re-retaining augmented memories");
  await deps.retainBatch(bankId, items);

  logger.info({ bankId, total: rows.length, classified, skipped }, "backfill complete");
  return { total: rows.length, classified, skipped };
}

async function readBank(
  bankId: string,
  listMemories: BackfillDeps["listMemories"],
): Promise<RawBankMemory[]> {
  const out: RawBankMemory[] = [];
  let offset = 0;
  while (true) {
    const page = await listMemories(bankId, { limit: PAGE_SIZE, offset });
    if (page.items.length === 0) break;

    for (const item of page.items) {
      const parsed = RawBankMemorySchema.parse(item);
      // Empty-string `context` means "no context" — Hindsight returns
      // an empty string rather than null for absent context. Normalise
      // to null so the retain path can drop the field entirely.
      const context =
        parsed.context !== undefined && parsed.context !== null && parsed.context.length > 0
          ? parsed.context
          : null;
      out.push({
        content: parsed.text,
        context,
        tags: parsed.tags ?? [],
        timestamp: parsed.date ?? null,
        // Round-trip whatever provenance metadata Hindsight returned so
        // the augmented row keeps its `source` stamp etc. Empty when
        // the source memory had none.
        metadata: parsed.metadata ?? {},
      });
    }

    offset += page.items.length;
    if (offset >= page.total) break;
  }
  return out;
}
