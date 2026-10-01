/**
 * Migrations 0068 and 0069: the Observer's per-phase cursors on
 * `conversations` and `contradicted_by_message_id` on `steering_rules`, then
 * the backfill that starts each observed conversation's cursors at its last
 * Observer fire. Runs the raw migration SQL against PGlite over rows written
 * in the pre-migration shape (the pushed schema's new columns dropped first).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { profiles, users } from "../agent/store/schema.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database, Transactor } from "./index.js";

async function migrationSql(file: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
}

const MIGRATIONS = [
  await migrationSql("0068_observer_cursors.sql"),
  await migrationSql("0069_observer_cursor_backfill.sql"),
];

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const CursorRowsSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      corrections_observed_through: z.string().nullable(),
      memories_observed_through: z.string().nullable(),
    }),
  ),
});
const MarkerRowsSchema = z.object({
  rows: z.array(z.object({ contradicted_by_message_id: z.string().nullable() })),
});

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let profileId: string;
let userId: string;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(sql`
    ALTER TABLE conversations
      DROP COLUMN IF EXISTS corrections_observed_through,
      DROP COLUMN IF EXISTS memories_observed_through
  `);
  await db.execute(
    sql`ALTER TABLE steering_rules DROP COLUMN IF EXISTS contradicted_by_message_id`,
  );
  const [user] = await db.insert(users).values({}).returning({ id: users.id });
  userId = expectDefined(user, "user").id;
  const [profile] = await db
    .insert(profiles)
    .values({ userId: null, name: "p", basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  profileId = expectDefined(profile, "profile").id;
});

afterAll(async () => {
  await close();
});

/** Each file runs in its own transaction, as the per-file migrator runs them. */
async function applyMigrations(): Promise<void> {
  for (const file of MIGRATIONS) {
    const statements = file
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await db.transaction(async (trx) => {
      for (const stmt of statements) await trx.execute(sql.raw(stmt));
    });
  }
}

/** A conversation in the pre-migration shape. Raw: Drizzle's insert names the dropped columns. */
async function seedConversation(): Promise<string> {
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO conversations (user_id, profile_id, is_private)
      VALUES (${userId}, ${profileId}, true)
      RETURNING id
    `),
  );
  return expectDefined(rows[0], "conversation").id;
}

async function seedMessage(conversationId: string, createdAt: string): Promise<string> {
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO messages
        (conversation_id, role, content, profile_id, model, last_inbound_message_id,
          output_tokens, created_at)
      VALUES (${conversationId}, 'user', '"hello"'::jsonb, ${profileId}, 'm',
        '019d0000-0000-7000-8000-0000000000ff', -1, ${createdAt}::timestamptz)
      RETURNING id
    `),
  );
  return expectDefined(rows[0], "message").id;
}

/**
 * An Observer audit row written at `createdAt`, the end of its fire. Only the
 * payload fields the backfill reads are set; an older row may lack either.
 */
async function seedFire(
  conversationId: string,
  createdAt: string,
  payload: { durationMs?: number; failedPhases?: string[] },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO evolution_events (conversation_id, user_id, triggered_by, payload, created_at)
    VALUES (${conversationId}, ${userId}, 'idle', ${JSON.stringify(payload)}::jsonb,
      ${createdAt}::timestamptz)
  `);
}

async function cursorsOf(conversationId: string) {
  const { rows } = CursorRowsSchema.parse(
    await db.execute(sql`
      SELECT id, corrections_observed_through, memories_observed_through
      FROM conversations WHERE id = ${conversationId}
    `),
  );
  return expectDefined(rows[0], conversationId);
}

describe("migrations 0068 and 0069 — observer cursors", () => {
  it("starts an observed conversation's cursors at the last message before its latest fire began", async () => {
    const conversationId = await seedConversation();
    await seedMessage(conversationId, "2026-09-01T09:00:00Z");
    await seedFire(conversationId, "2026-09-01T09:30:00Z", { durationMs: 60_000 });
    const seen = await seedMessage(conversationId, "2026-09-01T10:00:00Z");
    // The latest fire began at 10:01 and wrote its row at 10:05: a message
    // that arrived at 10:03 came after its history load.
    const during = await seedMessage(conversationId, "2026-09-01T10:03:00Z");
    await seedFire(conversationId, "2026-09-01T10:05:00Z", { durationMs: 240_000 });
    const after = await seedMessage(conversationId, "2026-09-01T10:06:00Z");

    await applyMigrations();

    expect(await cursorsOf(conversationId)).toMatchObject({
      corrections_observed_through: seen,
      memories_observed_through: seen,
    });
    const store = new DrizzleAgentStore();
    const unseen = await tx((trx) =>
      store.listMessagesInRange(trx, conversationId, { after: seen, through: after, limit: null }),
    );
    expect(unseen.map((m) => m.id)).toEqual([during, after]);
  });

  it("takes a fire without a recorded duration to have begun ten minutes before its row", async () => {
    const conversationId = await seedConversation();
    const seen = await seedMessage(conversationId, "2026-09-01T11:45:00Z");
    await seedMessage(conversationId, "2026-09-01T11:55:00Z");
    await seedFire(conversationId, "2026-09-01T12:00:00Z", {});

    await applyMigrations();

    expect(await cursorsOf(conversationId)).toMatchObject({
      corrections_observed_through: seen,
      memories_observed_through: seen,
    });
  });

  it("starts each phase's cursor at the latest fire that phase didn't fail", async () => {
    const conversationId = await seedConversation();
    const first = await seedMessage(conversationId, "2026-09-01T09:00:00Z");
    await seedFire(conversationId, "2026-09-01T10:00:00Z", { durationMs: 0, failedPhases: [] });
    const second = await seedMessage(conversationId, "2026-09-01T10:30:00Z");
    await seedFire(conversationId, "2026-09-01T11:00:00Z", {
      durationMs: 0,
      failedPhases: ["corrections", "drain"],
    });
    const onlyFailed = await seedConversation();
    const onlyMessage = await seedMessage(onlyFailed, "2026-09-01T09:00:00Z");
    await seedFire(onlyFailed, "2026-09-01T10:00:00Z", {
      durationMs: 0,
      failedPhases: ["memories"],
    });

    await applyMigrations();

    expect(await cursorsOf(conversationId)).toMatchObject({
      corrections_observed_through: first,
      memories_observed_through: second,
    });
    expect(await cursorsOf(onlyFailed)).toMatchObject({
      corrections_observed_through: onlyMessage,
      memories_observed_through: null,
    });
  });

  it("leaves a conversation the Observer never fired on unobserved", async () => {
    const conversationId = await seedConversation();
    await seedMessage(conversationId, "2026-09-01T10:00:00Z");

    await applyMigrations();

    expect(await cursorsOf(conversationId)).toMatchObject({
      corrections_observed_through: null,
      memories_observed_through: null,
    });
  });

  it("leaves a conversation whose fire predates its every message unobserved", async () => {
    const conversationId = await seedConversation();
    await seedFire(conversationId, "2026-09-01T09:00:00Z", { durationMs: 1_000 });
    await seedMessage(conversationId, "2026-09-01T10:00:00Z");

    await applyMigrations();

    expect(await cursorsOf(conversationId)).toMatchObject({
      corrections_observed_through: null,
      memories_observed_through: null,
    });
  });

  it("leaves existing rules uncontradicted", async () => {
    await db.execute(sql`
      INSERT INTO steering_rules (rule, category, active, source, priority, observation_count)
      VALUES ('Use metric units.', 'style', false, 'correction', 100, 1)
    `);

    await applyMigrations();

    const { rows } = MarkerRowsSchema.parse(
      await db.execute(sql`SELECT contradicted_by_message_id FROM steering_rules`),
    );
    expect(rows).toEqual([{ contradicted_by_message_id: null }]);
  });

  it("clears a cursor and a contradiction marker when their message is deleted", async () => {
    const conversationId = await seedConversation();
    const messageId = await seedMessage(conversationId, "2026-09-01T10:00:00Z");
    await applyMigrations();
    await db.execute(sql`
      UPDATE conversations
      SET corrections_observed_through = ${messageId}, memories_observed_through = ${messageId}
      WHERE id = ${conversationId}
    `);
    await db.execute(sql`
      INSERT INTO steering_rules
        (rule, category, active, source, priority, observation_count, contradicted_by_message_id)
      VALUES ('Use metric units.', 'style', false, 'correction', 100, 0, ${messageId})
    `);

    await db.execute(sql`DELETE FROM messages WHERE id = ${messageId}`);

    expect(await cursorsOf(conversationId)).toMatchObject({
      corrections_observed_through: null,
      memories_observed_through: null,
    });
    const { rows } = MarkerRowsSchema.parse(
      await db.execute(sql`SELECT contradicted_by_message_id FROM steering_rules`),
    );
    expect(rows).toEqual([{ contradicted_by_message_id: null }]);
  });
});
