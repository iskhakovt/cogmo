/**
 * CLI handlers for one-shot Hindsight migrations / backfills.
 *
 * Two entry points dispatched from `src/main.ts`:
 *
 *   `cogmo migrate-memories <bankId>` — reclassifies a Hindsight bank's
 *     un-classified memories through the Observer pipeline (existing
 *     `migrate-untagged-memories.ts` path). Stages every row into
 *     `pending_memories`, clears the bank, lets the next
 *     `conversation/idle` Observer run drain through the classifier
 *     and pick up `network/compartment/trust` (and `profile_class:*`
 *     when the profile carries one) tags.
 *
 *   `cogmo backfill profile-class --tag=<a,b> [--bankId=<id>]` —
 *     stamps `profile_class:<tag>` tags onto existing memories without
 *     re-classifying anything else. Faster ($0 LLM cost), no
 *     classifier drift on already-correct labels. Used by operators
 *     opting an existing deployment into class-scoped recall.
 *
 * Both share the same Hindsight wiring (HindsightClient + sdk client +
 * pre-clear backup file). Both write the backup BEFORE any destructive
 * step so the source-of-truth substrate exists if the clear or retain
 * fails partway through.
 *
 * `bankId` defaults to the first user's id (Cogmo's `bankId == userId`
 * convention) when omitted, matching the single-user-per-deployment
 * model. Operators with multiple users in one DB pass `--bankId=<id>`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, createConfig, HindsightClient, sdk } from "@vectorize-io/hindsight-client";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { AgentStore } from "../store/index.js";
import {
  type BackfillDeps,
  type RawBankMemory as BackfillRawBankMemory,
  backfillProfileClass,
  type RetainItem,
} from "./backfill-profile-class.js";
import {
  type MigrationDeps,
  migrateUntaggedMemories,
  type RawBankMemory,
} from "./migrate-untagged-memories.js";

export interface MigrationCliDeps {
  hindsightUrl: string;
  agentStore: AgentStore;
  runInTx: Transactor;
  /**
   * Resolves the default bank id when `--bankId` is omitted. Returns
   * the first user's id by convention. Returns `null` when no user
   * exists yet — the CLI surfaces a friendly usage line instead of
   * a thrown stack (operators run `cogmo seed` or the setup wizard
   * first).
   */
  resolveDefaultBankId: () => Promise<string | null>;
}

const PRE_RUN_NOTICE =
  "Pause Observer drains (or stop `cogmo serve`) before running this — concurrent retains during the migration window may be lost.";

const BACKUP_DIR = ".dev/memory-backups";

function makeBackupPath(bankId: string): string {
  mkdirSync(BACKUP_DIR, { recursive: true });
  return join(BACKUP_DIR, `${bankId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
}

function writeBackupFn<T>(backupPath: string): (rows: ReadonlyArray<T>) => Promise<void> {
  return async (rows) => {
    writeFileSync(backupPath, JSON.stringify(rows, null, 2));
    logger.info({ backupPath, count: rows.length }, "wrote pre-migration backup");
  };
}

function makeHindsightShared(hindsightUrl: string): {
  hindsight: HindsightClient;
  sdkClient: ReturnType<typeof createClient>;
} {
  return {
    hindsight: new HindsightClient({ baseUrl: hindsightUrl }),
    sdkClient: createClient(createConfig({ baseUrl: hindsightUrl })),
  };
}

/** `cogmo migrate-memories <bankId>` */
export async function runMigrateMemoriesCli(
  args: ReadonlyArray<string>,
  deps: MigrationCliDeps,
): Promise<number> {
  const bankId = args[0] ?? (await deps.resolveDefaultBankId());
  if (!bankId) {
    console.error(
      "Usage: cogmo migrate-memories <bankId>\n" +
        "No users in the database. Run `cogmo seed` or `cogmo setup` first.",
    );
    return 1;
  }

  const { hindsight, sdkClient } = makeHindsightShared(deps.hindsightUrl);
  const backupPath = makeBackupPath(bankId);
  console.log(`Migrating bank "${bankId}" — Hindsight ${deps.hindsightUrl}`);
  console.log(`Backup will be written to ${backupPath}`);
  console.warn(PRE_RUN_NOTICE);

  const migrationDeps: MigrationDeps = {
    listMemories: (id, opts) => hindsight.listMemories(id, opts),
    clearBankMemories: async (id) => {
      const res = await sdk.clearBankMemories({ client: sdkClient, path: { bank_id: id } });
      if (res.error) {
        throw new Error(`clearBankMemories failed: ${JSON.stringify(res.error)}`);
      }
    },
    runInTx: deps.runInTx,
    agentStore: deps.agentStore,
    writeBackup: writeBackupFn<RawBankMemory>(backupPath),
  };

  const result = await migrateUntaggedMemories(bankId, migrationDeps);
  console.log(`\nMigrated ${result.migrated} memories — staged in pending_memories.`);
  console.log("Trigger any conversation/idle to drain them through the Observer classifier.");
  return 0;
}

/**
 * Parse `cogmo backfill profile-class --tag=a,b [--bankId=X]`. Returns
 * the parsed shape or a usage-error string. `--tag` is required; class
 * names are split on comma, trimmed, and de-duplicated. Empty class
 * names rejected.
 */
export interface ParsedBackfillArgs {
  classTags: string[];
  bankIdOverride: string | null;
}

export function parseBackfillArgs(args: ReadonlyArray<string>): ParsedBackfillArgs | string {
  // First positional arg must be `profile-class` — a forward-compatible
  // namespace so future backfill subcommands don't collide on flags.
  if (args[0] !== "profile-class") {
    return "Usage: cogmo backfill profile-class --tag=<a,b> [--bankId=<id>]";
  }
  let bankIdOverride: string | null = null;
  let tagArg: string | null = null;
  for (const arg of args.slice(1)) {
    if (arg.startsWith("--tag=")) tagArg = arg.slice("--tag=".length);
    else if (arg.startsWith("--bankId=")) bankIdOverride = arg.slice("--bankId=".length);
    else
      return `Unknown argument "${arg}". Usage: cogmo backfill profile-class --tag=<a,b> [--bankId=<id>]`;
  }
  if (tagArg === null) {
    return "Missing --tag=<a,b>. At least one class tag is required.";
  }
  const classTags = Array.from(
    new Set(
      tagArg
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    ),
  );
  if (classTags.length === 0) {
    return "--tag=<a,b> must contain at least one non-empty class name.";
  }
  return { classTags, bankIdOverride };
}

/** `cogmo backfill profile-class --tag=a,b [--bankId=X]` */
export async function runBackfillProfileClassCli(
  args: ReadonlyArray<string>,
  deps: MigrationCliDeps,
): Promise<number> {
  const parsed = parseBackfillArgs(args);
  if (typeof parsed === "string") {
    console.error(parsed);
    return 1;
  }

  const bankId = parsed.bankIdOverride ?? (await deps.resolveDefaultBankId());
  if (!bankId) {
    console.error(
      "Usage: cogmo backfill profile-class --tag=<a,b> [--bankId=<id>]\n" +
        "No users in the database. Run `cogmo seed` or `cogmo setup` first.",
    );
    return 1;
  }
  const { hindsight, sdkClient } = makeHindsightShared(deps.hindsightUrl);
  const backupPath = makeBackupPath(bankId);
  console.log(`Backfilling bank "${bankId}" with classes [${parsed.classTags.join(", ")}]`);
  console.log(`Hindsight ${deps.hindsightUrl}`);
  console.log(`Backup will be written to ${backupPath}`);
  console.warn(PRE_RUN_NOTICE);

  // Operator-facing nuance worth surfacing once: the skip path is
  // tag-presence-based, not tag-value-based. A row already carrying
  // any `profile_class:*` is passed through unchanged regardless of
  // which `--tag` values you pass. So a partial first run with
  // `--tag=general` followed by a second with `--tag=legacy` does
  // NOT add `legacy` to the already-`general`-tagged rows. Pass
  // both on the first invocation if you want both. The note below
  // only fires when there's a real risk of confusion (multi-tag
  // call against a bank that already has any classed rows).
  if (parsed.classTags.length > 1) {
    const probe = await hindsight.listMemories(bankId, { limit: 100, offset: 0 });
    const anyClassed = probe.items.some((item) => {
      const tags = (item as { tags?: string[] }).tags ?? [];
      return tags.some((t) => t.startsWith("profile_class:"));
    });
    if (anyClassed) {
      console.warn(
        "Note: some memories in this bank already carry a profile_class:* tag. " +
          "Backfill skips those rows entirely — it does NOT append additional " +
          "profile_class:* values from --tag to existing classed rows. To stamp " +
          "multiple values, pass them all on the first run.",
      );
    }
  }

  const backfillDeps: BackfillDeps = {
    listMemories: (id, opts) => hindsight.listMemories(id, opts),
    clearBankMemories: async (id) => {
      const res = await sdk.clearBankMemories({ client: sdkClient, path: { bank_id: id } });
      if (res.error) {
        throw new Error(`clearBankMemories failed: ${JSON.stringify(res.error)}`);
      }
    },
    retainBatch: async (id, items: ReadonlyArray<RetainItem>) => {
      // async: false so the CLI exits only after Hindsight has
      // ingested the augmented rows — no race with the operator's
      // "verify by /status or recall" follow-up.
      await hindsight.retainBatch(id, [...items], { async: false });
    },
    writeBackup: writeBackupFn<BackfillRawBankMemory>(backupPath),
  };

  const result = await backfillProfileClass(bankId, backfillDeps, { classTags: parsed.classTags });
  console.log(
    `\nBackfill complete — total: ${result.total}, classified: ${result.classified}, skipped: ${result.skipped}`,
  );
  return 0;
}
