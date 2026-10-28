/**
 * Migration 0074 closes every active session but the newest per address, so
 * that 0075 can build `uq_sessions_active_address` over rows written before
 * the index existed. Runs both migrations' raw SQL against PGlite with the
 * index dropped first, over addresses holding one, two and no active rows.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { seedConversation } from "../test/agent-store-fixtures.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import type { Database, Transactor } from "./index.js";
import { findPgErrorByCode } from "./pg-errors.js";

async function migrationSql(file: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
}
const CLOSE_DUPLICATES_SQL = await migrationSql("0074_sessions_close_duplicate_active.sql");
const CREATE_INDEX_SQL = await migrationSql("0075_sessions_one_active_per_address.sql");

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const StatusRowsSchema = z.object({
  rows: z.array(z.object({ id: z.string(), status: z.string() })),
});

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleTransportStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(sql`DROP INDEX IF EXISTS uq_sessions_active_address`);
});

afterAll(async () => {
  await close();
});

async function apply(migration: string): Promise<void> {
  const statements = migration
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

async function insertSession(
  channelId: string,
  platformAddress: string,
  conversationId: string,
  status: string,
): Promise<string> {
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO channel_sessions (channel_id, platform_address, conversation_id, status, receive)
      VALUES (${channelId}, ${platformAddress}, ${conversationId}, ${status}, 'routed')
      RETURNING id
    `),
  );
  return expectDefined(rows[0], "inserted row").id;
}

async function statusById(): Promise<Record<string, string>> {
  const { rows } = StatusRowsSchema.parse(
    await db.execute(sql`SELECT id, status::text AS status FROM channel_sessions`),
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

describe("migration 0074 — close duplicate active sessions", () => {
  it("keeps the newest active row per address and leaves every other row as it was", async () => {
    const channelId = (
      await tx((trx) =>
        store.createChannel(trx, { type: "direct", credentials: {}, identityMode: "fixed" }),
      )
    ).id;
    const { conversationId } = await seedConversation(tx);
    const olderDuplicate = await insertSession(channelId, "dup", conversationId, "active");
    const newestDuplicate = await insertSession(channelId, "dup", conversationId, "active");
    const alreadyClosed = await insertSession(channelId, "dup", conversationId, "closed");
    const single = await insertSession(channelId, "single", conversationId, "active");
    const onlyClosed = await insertSession(channelId, "gone", conversationId, "closed");

    await apply(CLOSE_DUPLICATES_SQL);

    expect(await statusById()).toEqual({
      [olderDuplicate]: "closed",
      [newestDuplicate]: "active",
      [alreadyClosed]: "closed",
      [single]: "active",
      [onlyClosed]: "closed",
    });
  });

  it("then 0075 builds the unique index the duplicates would have rejected", async () => {
    const channelId = (
      await tx((trx) =>
        store.createChannel(trx, { type: "direct", credentials: {}, identityMode: "fixed" }),
      )
    ).id;
    const { conversationId } = await seedConversation(tx);
    await insertSession(channelId, "dup", conversationId, "active");
    await insertSession(channelId, "dup", conversationId, "active");

    const indexOverDuplicates = await apply(CREATE_INDEX_SQL).then(
      () => null,
      (error: unknown) => error,
    );
    expect(findPgErrorByCode(indexOverDuplicates, ["23505"])).toBeDefined();
    await apply(CLOSE_DUPLICATES_SQL);
    await apply(CREATE_INDEX_SQL);

    const thirdActive = await insertSession(channelId, "dup", conversationId, "active").then(
      () => null,
      (error: unknown) => error,
    );
    expect(findPgErrorByCode(thirdActive, ["23505"])).toMatchObject({ code: "23505" });
  });
});
