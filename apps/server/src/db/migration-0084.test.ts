/**
 * The `_transcript_head_epoch_reason` migration (found through the journal)
 * adds `messages.transcript_head`, held to assistant rows by a CHECK, and
 * `system_prompt_snapshots.reason`, the `system_prompt_epoch_reason` enum, in
 * one transaction: create the type, add both columns, backfill `reason` in the
 * epoch rule's precedence over each conversation's snapshots ordered by
 * `opened_by`, set it NOT NULL, add the CHECK. Runs the raw SQL against PGlite
 * over rows in the pre-migration shape (the pushed schema's new columns,
 * constraint and type dropped), one snapshot per precedence case.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { seedConversation } from "../test/agent-store-fixtures.js";
import { expectDefined, expectPgError } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database, Transactor } from "./index.js";
import { findPgErrorByCode } from "./pg-errors.js";

const JournalSchema = z.object({ entries: z.array(z.object({ tag: z.string() })) });
const ENTRIES = JournalSchema.parse(
  JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../migrations/meta/_journal.json", import.meta.url)),
      "utf8",
    ),
  ),
).entries.filter((e) => e.tag.endsWith("_transcript_head_epoch_reason"));
if (ENTRIES.length !== 1) {
  throw new Error(
    `expected one _transcript_head_epoch_reason journal entry, found ${ENTRIES.length}`,
  );
}
const MIGRATION_TAG = expectDefined(ENTRIES[0], "the journal entry").tag;
const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL(`../../migrations/${MIGRATION_TAG}.sql`, import.meta.url)),
  "utf8",
);

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const ReasonRowsSchema = z.object({
  rows: z.array(z.object({ id: z.string(), reason: z.string().nullable() })),
});
const ColumnRowsSchema = z.object({
  rows: z.array(
    z.object({ table_name: z.string(), column_name: z.string(), is_nullable: z.string() }),
  ),
});

const NOT_NULL_VIOLATION = "23502";
const CHECK_VIOLATION = "23514";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleAgentStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(
    sql`ALTER TABLE messages DROP CONSTRAINT IF EXISTS chk_messages_transcript_head_assistant`,
  );
  await db.execute(sql`ALTER TABLE messages DROP COLUMN IF EXISTS transcript_head`);
  await db.execute(sql`ALTER TABLE system_prompt_snapshots DROP COLUMN IF EXISTS reason`);
  await db.execute(sql`DROP TYPE IF EXISTS system_prompt_epoch_reason`);
});

afterAll(async () => {
  await close();
});

/** The file as `migratePerFile` runs it: every statement in one transaction. */
async function applyMigration(): Promise<void> {
  const statements = MIGRATION_SQL.split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await db.transaction(async (trx) => {
    for (const stmt of statements) {
      await trx.execute(sql.raw(stmt));
    }
  });
}

/** `count` rows of `conversationId`, oldest first, in the pre-migration shape. */
async function insertRows(
  conversationId: string,
  profileId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const { rows } = IdRowsSchema.parse(
      await db.execute(sql`
        INSERT INTO messages
          (conversation_id, role, content, profile_id, model, last_inbound_message_id, output_tokens)
        VALUES (${conversationId}, 'user', ${JSON.stringify(`m${i}`)}::jsonb, ${profileId}, 'm',
          '019d0000-0000-7000-8000-0000000000fe', -1)
        RETURNING id
      `),
    );
    ids.push(expectDefined(rows[0], `row ${i}`).id);
  }
  return ids;
}

/** A conversation and `count` of its rows. */
async function seedRows(
  count: number,
): Promise<{ conversationId: string; ids: string[]; userId: string; profileId: string }> {
  const { conversationId, userId, profileId } = await seedConversation(tx);
  return {
    conversationId,
    userId,
    profileId,
    ids: await insertRows(conversationId, profileId, count),
  };
}

interface LegacySnapshot {
  openedBy: string;
  historyStart: string;
  configDigest: string;
  attachmentCutoff: string | null;
}

/** Insert a snapshot in the pre-migration shape; returns its id. */
async function insertSnapshot(conversationId: string, s: LegacySnapshot): Promise<string> {
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO system_prompt_snapshots
        (conversation_id, opened_by, history_start, rendered, config_digest, attachment_cutoff)
      VALUES (${conversationId}, ${s.openedBy}, ${s.historyStart}, 'prompt', ${s.configDigest},
        ${s.attachmentCutoff})
      RETURNING id
    `),
  );
  return expectDefined(rows[0], "snapshot").id;
}

async function reasonsById(): Promise<Record<string, string | null>> {
  const { rows } = ReasonRowsSchema.parse(
    await db.execute(sql`SELECT id, reason::text AS reason FROM system_prompt_snapshots`),
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.reason]));
}

describe("migration transcript_head_epoch_reason", () => {
  it("backfills each snapshot's reason in the epoch rule's precedence, per conversation", async () => {
    const { conversationId, ids, userId, profileId } = await seedRows(8);
    const m = (i: number) => expectDefined(ids[i], `m${i}`);
    const otherId = (
      await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
    ).id;
    const other = { conversationId: otherId, ids: await insertRows(otherId, profileId, 1) };
    const at = (openedBy: number, overrides: Partial<LegacySnapshot>): LegacySnapshot => ({
      openedBy: m(openedBy),
      historyStart: m(0),
      configDigest: "d1",
      attachmentCutoff: null,
      ...overrides,
    });
    // Inserted out of transcript order: the backfill orders by `opened_by`.
    const labelled: Array<[string, LegacySnapshot]> = [
      [
        "summary, then attachments",
        at(7, { configDigest: "d3", historyStart: m(5), attachmentCutoff: m(4) }),
      ],
      ["first", at(0, {})],
      ["configuration", at(1, { configDigest: "d2" })],
      ["summary", at(2, { configDigest: "d2", historyStart: m(2) })],
      ["attachments", at(3, { configDigest: "d2", historyStart: m(2), attachmentCutoff: m(1) })],
      ["no change", at(4, { configDigest: "d2", historyStart: m(2), attachmentCutoff: m(1) })],
      [
        "configuration, then summary",
        at(5, { configDigest: "d3", historyStart: m(4), attachmentCutoff: m(1) }),
      ],
      [
        "attachments cleared",
        at(6, { configDigest: "d3", historyStart: m(4), attachmentCutoff: null }),
      ],
    ];
    const labels = new Map<string, string>();
    for (const [label, snapshot] of labelled) {
      labels.set(await insertSnapshot(conversationId, snapshot), label);
    }
    const otherFirst = await insertSnapshot(other.conversationId, {
      openedBy: expectDefined(other.ids[0], "other row"),
      historyStart: expectDefined(other.ids[0], "other row"),
      configDigest: "d9",
      attachmentCutoff: null,
    });
    labels.set(otherFirst, "another conversation's first");

    await applyMigration();

    const reasons = await reasonsById();
    expect(Object.fromEntries([...labels].map(([id, label]) => [label, reasons[id]]))).toEqual({
      first: "first_turn",
      configuration: "configuration",
      summary: "summary",
      attachments: "attachments",
      "no change": "configuration",
      "configuration, then summary": "configuration",
      "attachments cleared": "attachments",
      "summary, then attachments": "summary",
      "another conversation's first": "first_turn",
    });
  });

  it("then requires a reason, holds heads to assistant rows, and leaves rows the store reads", async () => {
    const { conversationId, ids, profileId } = await seedRows(1);
    const opener = expectDefined(ids[0], "opener");
    await insertSnapshot(conversationId, {
      openedBy: opener,
      historyStart: opener,
      configDigest: "d1",
      attachmentCutoff: null,
    });

    await applyMigration();

    const { rows } = ColumnRowsSchema.parse(
      await db.execute(sql`
        SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE (table_name = 'system_prompt_snapshots' AND column_name = 'reason')
          OR (table_name = 'messages' AND column_name = 'transcript_head')
        ORDER BY table_name
      `),
    );
    expect(rows).toEqual([
      { table_name: "messages", column_name: "transcript_head", is_nullable: "YES" },
      { table_name: "system_prompt_snapshots", column_name: "reason", is_nullable: "NO" },
    ]);

    const reasonless = await db
      .execute(sql`
        INSERT INTO system_prompt_snapshots
          (conversation_id, opened_by, history_start, rendered, config_digest)
        VALUES (${conversationId}, ${opener}, ${opener}, 'prompt', 'd2')
      `)
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(findPgErrorByCode(reasonless, [NOT_NULL_VIOLATION])).not.toBeNull();

    const head = JSON.stringify({
      length: 1,
      digest: "b".repeat(64),
      base: "a".repeat(64),
      historyStart: opener,
      status: "intact",
    });
    const headedUserRow = await db
      .execute(sql`
        INSERT INTO messages
          (conversation_id, role, content, profile_id, model, last_inbound_message_id,
            output_tokens, transcript_head)
        VALUES (${conversationId}, 'user', '"hi"'::jsonb, ${profileId}, 'm',
          '019d0000-0000-7000-8000-0000000000fe', -1, ${head}::jsonb)
      `)
      .then(
        () => null,
        (err: unknown) => err,
      );
    expectPgError(headedUserRow, CHECK_VIOLATION, "chk_messages_transcript_head_assistant");

    const latest = await tx((trx) => store.getLatestSystemPromptSnapshot(trx, conversationId));
    expect(latest?.reason).toBe("first_turn");
  });
});
