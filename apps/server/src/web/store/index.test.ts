import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DrizzleAgentStore } from "../../agent/store/index.js";
import type { Database, Transactor } from "../../db/index.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleWebSessionStore } from "./index.js";
import { webSessions } from "./schema.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleWebSessionStore;
let agentStore: DrizzleAgentStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleWebSessionStore();
  agentStore = new DrizzleAgentStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

function makeUser(): Promise<string> {
  return tx(async (trx) => (await agentStore.createUser(trx)).id);
}

const future = () => new Date(Date.now() + 60_000);

describe("DrizzleWebSessionStore", () => {
  it("create + findValidByTokenHash round-trips", async () => {
    const userId = await makeUser();
    await tx((trx) => store.create(trx, { tokenHash: "h1", userId, expiresAt: future() }));
    const row = await tx((trx) => store.findValidByTokenHash(trx, "h1", new Date()));
    expect(row?.userId).toBe(userId);
  });

  it("excludes expired sessions", async () => {
    const userId = await makeUser();
    const past = new Date(Date.now() - 1000);
    await tx((trx) => store.create(trx, { tokenHash: "h2", userId, expiresAt: past }));
    expect(await tx((trx) => store.findValidByTokenHash(trx, "h2", new Date()))).toBeUndefined();
  });

  it("enforces a unique token_hash", async () => {
    const userId = await makeUser();
    await tx((trx) => store.create(trx, { tokenHash: "dup", userId, expiresAt: future() }));
    await expect(
      tx((trx) => store.create(trx, { tokenHash: "dup", userId, expiresAt: future() })),
    ).rejects.toThrow();
  });

  it("touch updates last_used_at", async () => {
    const userId = await makeUser();
    const { id } = await tx((trx) =>
      store.create(trx, { tokenHash: "h3", userId, expiresAt: future() }),
    );
    const later = new Date(Date.now() + 5000);
    await tx((trx) => store.touch(trx, id, later));
    const rows = await db
      .select({ lastUsedAt: webSessions.lastUsedAt })
      .from(webSessions)
      .where(eq(webSessions.id, id));
    expect(expectDefined(rows[0], "touched row").lastUsedAt.getTime()).toBe(later.getTime());
  });

  it("deleteByTokenHash removes the row", async () => {
    const userId = await makeUser();
    await tx((trx) => store.create(trx, { tokenHash: "h4", userId, expiresAt: future() }));
    await tx((trx) => store.deleteByTokenHash(trx, "h4"));
    expect(await tx((trx) => store.findValidByTokenHash(trx, "h4", new Date()))).toBeUndefined();
  });

  it("deleteExpired purges only expired rows", async () => {
    const userId = await makeUser();
    await tx((trx) => store.create(trx, { tokenHash: "live", userId, expiresAt: future() }));
    await tx((trx) =>
      store.create(trx, { tokenHash: "dead", userId, expiresAt: new Date(Date.now() - 1000) }),
    );
    await tx((trx) => store.deleteExpired(trx, new Date()));
    const remaining = await db.select({ tokenHash: webSessions.tokenHash }).from(webSessions);
    expect(remaining.map((r) => r.tokenHash)).toEqual(["live"]);
  });
});
