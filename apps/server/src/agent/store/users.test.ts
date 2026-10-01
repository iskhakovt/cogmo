import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleUserStore } from "./users.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleUserStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("DrizzleUserStore", () => {
  describe("users", () => {
    it("creates a user and retrieves it", async () => {
      const { id } = await tx((trx) => store.createUser(trx));
      expect(id).toBeDefined();

      const first = await tx((trx) => store.getFirstUser(trx));
      expect(first?.id).toBe(id);
    });

    it("returns null when no users exist", async () => {
      expect(await tx((trx) => store.getFirstUser(trx))).toBeUndefined();
    });

    it("getFirstUser returns the oldest user when a newer row reuses a freed slot", async () => {
      const { id: gone } = await tx((trx) => store.createUser(trx));
      const { id: oldest } = await tx((trx) => store.createUser(trx));
      // Adversarial setup: nothing deletes users, but a vacuumed gap at the
      // front of the heap is where the next insert lands.
      await db.execute(sql`DELETE FROM users WHERE id = ${gone}`);
      await db.execute(sql`VACUUM users`);
      await tx((trx) => store.createUser(trx));

      expect((await tx((trx) => store.getFirstUser(trx)))?.id).toBe(oldest);
    });
  });
});
