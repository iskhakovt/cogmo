/**
 * Migration 0073 moves `messages.role` to `message_role` and
 * `channels.identity_mode` to `channel_identity_mode`, dropping
 * `uq_channels_fixed_type` around the type change: `ALTER COLUMN TYPE`
 * rebuilds a partial index from its stored predicate, which compares the
 * column with a `text` literal, and Postgres has no enum = text operator.
 * Runs the raw migration SQL against PGlite over rows written in the
 * pre-migration shape (the pushed schema's enums reverted to `text` first).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { seedConversation } from "../test/agent-store-fixtures.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import type { Database, Transactor } from "./index.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0073_identity_mode_and_role_enums.sql", import.meta.url)),
  "utf8",
);

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const ValueRowsSchema = z.object({
  rows: z.array(z.object({ id: z.string(), value: z.string() })),
});

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(sql`DROP INDEX IF EXISTS uq_channels_fixed_type`);
  await db.execute(sql`ALTER TABLE channels ALTER COLUMN identity_mode TYPE text`);
  await db.execute(sql`ALTER TABLE messages ALTER COLUMN role TYPE text`);
  await db.execute(sql`DROP TYPE IF EXISTS channel_identity_mode`);
  await db.execute(sql`DROP TYPE IF EXISTS message_role`);
  await db.execute(sql`
    CREATE UNIQUE INDEX uq_channels_fixed_type ON channels (type) WHERE identity_mode = 'fixed'
  `);
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

async function insertChannel(type: string, identityMode: string): Promise<string> {
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO channels (type, credentials, identity_mode)
      VALUES (${type}, '{}', ${identityMode}) RETURNING id
    `),
  );
  return expectDefined(rows[0], "inserted row").id;
}

type Conversation = Awaited<ReturnType<typeof seedConversation>>;

async function insertMessage(
  { conversationId, stamp }: Conversation,
  role: string,
): Promise<string> {
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO messages
        (conversation_id, role, content, profile_id, model, last_inbound_message_id, output_tokens)
      VALUES (${conversationId}, ${role}, '"x"', ${stamp.profileId}, ${stamp.model},
        '019d0000-0000-7000-8000-000000000001', -1)
      RETURNING id
    `),
  );
  return expectDefined(rows[0], "inserted row").id;
}

async function valuesById(query: SQL): Promise<Record<string, string>> {
  const { rows } = ValueRowsSchema.parse(await db.execute(query));
  return Object.fromEntries(rows.map((r) => [r.id, r.value]));
}

describe("migration 0073 — identity mode and role enums", () => {
  it("keeps every row's identity mode and role", async () => {
    const channels = {
      [await insertChannel("direct", "fixed")]: "fixed",
      [await insertChannel("telegram", "fixed")]: "fixed",
      [await insertChannel("telegram", "mapped")]: "mapped",
      [await insertChannel("web", "create")]: "create",
    };
    const conversation = await seedConversation(tx);
    const messages = {
      [await insertMessage(conversation, "user")]: "user",
      [await insertMessage(conversation, "assistant")]: "assistant",
    };

    await applyMigration();

    expect(await valuesById(sql`SELECT id, identity_mode::text AS value FROM channels`)).toEqual(
      channels,
    );
    expect(await valuesById(sql`SELECT id, role::text AS value FROM messages`)).toEqual(messages);
  });

  it("then keys fixed channels, and only those, on their type", async () => {
    const direct = await insertChannel("direct", "fixed");

    await applyMigration();

    const recovered = await tx((trx) =>
      new DrizzleTransportStore().insertOrRecoverFixedChannel(trx, "direct"),
    );
    expect(recovered).toEqual({ kind: "recovered", id: direct });
    await expect(insertChannel("direct", "fixed")).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/uq_channels_fixed_type/) },
    });
    await insertChannel("direct", "mapped");
  });

  it("then refuses an identity mode or role outside its enum", async () => {
    const conversation = await seedConversation(tx);
    await applyMigration();

    await expect(insertChannel("web", "shared")).rejects.toMatchObject({
      cause: {
        message: expect.stringMatching(/invalid input value for enum channel_identity_mode/),
      },
    });
    await expect(insertMessage(conversation, "system")).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/invalid input value for enum message_role/) },
    });
  });
});
