/**
 * Migration 0068 adds the Observer's per-phase cursors to `conversations`
 * and `contradicted_through_message_id` to `steering_rules`. Runs the raw
 * migration SQL against PGlite over rows written in the pre-migration shape
 * (the pushed schema's new columns dropped first) and asserts that existing
 * conversations and rules come through with the new columns NULL, so their
 * next Observer fire reads the whole history, and that each foreign key
 * clears its column when the message goes.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { messages, profiles, users } from "../agent/store/schema.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database } from "./index.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0068_observer_cursors.sql", import.meta.url)),
  "utf8",
);

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const CursorRowsSchema = z.object({
  rows: z.array(
    z.object({
      corrections_observed_through: z.string().nullable(),
      memories_observed_through: z.string().nullable(),
    }),
  ),
});
const MarkerRowsSchema = z.object({
  rows: z.array(z.object({ contradicted_through_message_id: z.string().nullable() })),
});

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(sql`
    ALTER TABLE conversations
      DROP COLUMN IF EXISTS corrections_observed_through,
      DROP COLUMN IF EXISTS memories_observed_through
  `);
  await db.execute(
    sql`ALTER TABLE steering_rules DROP COLUMN IF EXISTS contradicted_through_message_id`,
  );
});

afterAll(async () => {
  await close();
});

async function applyMigration(): Promise<void> {
  const statements = MIGRATION_SQL.split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

/** A conversation with one message, written in the pre-migration shape. */
async function seedConversation(): Promise<{ conversationId: string; messageId: string }> {
  const [user] = await db.insert(users).values({}).returning({ id: users.id });
  const [profile] = await db
    .insert(profiles)
    .values({ userId: null, name: "p", basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  const profileId = expectDefined(profile, "profile").id;
  // Raw: Drizzle's insert names every column the pushed schema has, the dropped ones included.
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO conversations (user_id, profile_id, is_private)
      VALUES (${expectDefined(user, "user").id}, ${profileId}, true)
      RETURNING id
    `),
  );
  const conversationId = expectDefined(rows[0], "conversation").id;
  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      role: "user",
      content: "hello",
      profileId,
      model: "m",
      lastInboundMessageId: "019d0000-0000-7000-8000-0000000000ff",
      outputTokens: -1,
    })
    .returning({ id: messages.id });
  return { conversationId, messageId: expectDefined(message, "message").id };
}

async function cursors() {
  return CursorRowsSchema.parse(
    await db.execute(
      sql`SELECT corrections_observed_through, memories_observed_through FROM conversations`,
    ),
  ).rows;
}

describe("migration 0068 — observer cursors", () => {
  it("leaves existing conversations and rules unobserved and uncontradicted", async () => {
    await seedConversation();
    await db.execute(sql`
      INSERT INTO steering_rules (rule, category, active, source, priority, observation_count)
      VALUES ('Use metric units.', 'style', false, 'correction', 100, 1)
    `);

    await applyMigration();

    expect(await cursors()).toEqual([
      { corrections_observed_through: null, memories_observed_through: null },
    ]);
    const { rows } = MarkerRowsSchema.parse(
      await db.execute(sql`SELECT contradicted_through_message_id FROM steering_rules`),
    );
    expect(rows).toEqual([{ contradicted_through_message_id: null }]);
  });

  it("clears a cursor and a contradiction marker when their message is deleted", async () => {
    const { conversationId, messageId } = await seedConversation();
    await applyMigration();
    await db.execute(sql`
      UPDATE conversations
      SET corrections_observed_through = ${messageId}, memories_observed_through = ${messageId}
      WHERE id = ${conversationId}
    `);
    await db.execute(sql`
      INSERT INTO steering_rules
        (rule, category, active, source, priority, observation_count, contradicted_through_message_id)
      VALUES ('Use metric units.', 'style', false, 'correction', 100, 0, ${messageId})
    `);

    await db.execute(sql`DELETE FROM messages WHERE id = ${messageId}`);

    expect(await cursors()).toEqual([
      { corrections_observed_through: null, memories_observed_through: null },
    ]);
    const { rows } = MarkerRowsSchema.parse(
      await db.execute(sql`SELECT contradicted_through_message_id FROM steering_rules`),
    );
    expect(rows).toEqual([{ contradicted_through_message_id: null }]);
  });
});
