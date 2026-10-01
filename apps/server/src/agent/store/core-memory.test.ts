import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database, Transactor } from "../../db/index.js";
import { expectDefined, expectOk } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { type CoreMemoryUpsertOutcome, DrizzleCoreMemoryStore } from "./core-memory.js";
import { DrizzleProfileClassStore } from "./profile-classes.js";
import { coreMemoryBlocks } from "./schema.js";
import { seedUser } from "./test-fixtures.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleCoreMemoryStore();
const profileClassStore = new DrizzleProfileClassStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("DrizzleCoreMemoryStore", () => {
  describe("core memory blocks", () => {
    async function upsert(
      userId: string,
      profileClass: string | null,
      key: string,
      content: string,
    ): Promise<CoreMemoryUpsertOutcome> {
      return tx((trx) => store.upsertCoreMemoryBlock(trx, { userId, profileClass, key, content }));
    }

    async function seedClass(userId: string, name: string): Promise<void> {
      await tx((trx) =>
        profileClassStore
          .createProfileClass(trx, { userId, name, description: name })
          .then(expectOk),
      );
    }

    it("upsert creates a new block", async () => {
      const userId = await seedUser(tx);
      await upsert(userId, null, "user_profile", "Name: Tim");

      const blocks = await tx((trx) => store.getCoreMemoryBlocks(trx, userId, null));
      expect(blocks).toEqual([{ profileClass: null, key: "user_profile", content: "Name: Tim" }]);
    });

    it("upsert replaces the block in its scope, including the NULL-class scope", async () => {
      const userId = await seedUser(tx);
      await upsert(userId, null, "user_profile", "Name: Tim");
      await upsert(userId, null, "user_profile", "Name: Tim\nRole: Engineer");

      const blocks = await tx((trx) => store.getCoreMemoryBlocks(trx, userId, null));
      expect(blocks).toEqual([
        { profileClass: null, key: "user_profile", content: "Name: Tim\nRole: Engineer" },
      ]);
      const rows = await db
        .select({ id: coreMemoryBlocks.id })
        .from(coreMemoryBlocks)
        .where(eq(coreMemoryBlocks.userId, userId));
      expect(rows).toHaveLength(1);
    });

    it("upsert reports whether it created the block, changed it or left it as it was", async () => {
      const userId = await seedUser(tx);
      await seedClass(userId, "game");

      expect(await upsert(userId, null, "identity", "Name: Tim")).toBe("created");
      expect(await upsert(userId, null, "identity", "Name: Tim\nHome: Lisbon")).toBe("updated");
      expect(await upsert(userId, null, "identity", "Name: Tim\nHome: Lisbon")).toBe("unchanged");
      expect(await upsert(userId, "game", "identity", "Name: Tim\nHome: Lisbon")).toBe("created");
    });

    it("an upsert that leaves the content as it was keeps the block's updated_at", async () => {
      const userId = await seedUser(tx);
      await upsert(userId, null, "identity", "Name: Tim");
      const past = new Date("2026-01-01T00:00:00Z");
      await db
        .update(coreMemoryBlocks)
        .set({ updatedAt: past })
        .where(eq(coreMemoryBlocks.userId, userId));

      await upsert(userId, null, "identity", "Name: Tim");

      const times = await tx((trx) => store.getCoreMemoryUpdateTimes(trx, userId));
      expect(times.map((t) => t.updatedAt)).toEqual([past]);
    });

    it("an unclassed read returns every NULL-class block in key order, identity included", async () => {
      const userId = await seedUser(tx);
      await seedClass(userId, "game");
      await upsert(userId, null, "user_profile", "Tim");
      await upsert(userId, null, "identity", "Name: Tim");
      await upsert(userId, null, "active_projects", "Assistant");
      await upsert(userId, "game", "preferences", "Call me Thorin");

      const blocks = await tx((trx) => store.getCoreMemoryBlocks(trx, userId, null));
      expect(blocks.map((b) => b.key)).toEqual(["active_projects", "identity", "user_profile"]);
      expect(blocks.every((b) => b.profileClass === null)).toBe(true);
    });

    it("a class reads the shared identity, then its own blocks, never the unclassed bucket or another class", async () => {
      const userId = await seedUser(tx);
      await seedClass(userId, "coder");
      await seedClass(userId, "game");
      await upsert(userId, null, "identity", "Name: Tim");
      await upsert(userId, null, "user_profile", "Family: Alex");
      await upsert(userId, "coder", "preferences", "TypeScript");
      await upsert(userId, "coder", "active_projects", "Cogmo");
      await upsert(userId, "game", "preferences", "Call me Thorin");

      const blocks = await tx((trx) => store.getCoreMemoryBlocks(trx, userId, "coder"));
      expect(blocks).toEqual([
        { profileClass: null, key: "identity", content: "Name: Tim" },
        { profileClass: "coder", key: "active_projects", content: "Cogmo" },
        { profileClass: "coder", key: "preferences", content: "TypeScript" },
      ]);
    });

    it("a class's identity override follows the shared identity and leads the class's blocks", async () => {
      const userId = await seedUser(tx);
      await seedClass(userId, "game");
      await upsert(userId, "game", "active_projects", "Campaign");
      await upsert(userId, "game", "identity", "Name: Thorin");
      await upsert(userId, null, "identity", "Name: Tim");

      const blocks = await tx((trx) => store.getCoreMemoryBlocks(trx, userId, "game"));
      expect(blocks).toEqual([
        { profileClass: null, key: "identity", content: "Name: Tim" },
        { profileClass: "game", key: "identity", content: "Name: Thorin" },
        { profileClass: "game", key: "active_projects", content: "Campaign" },
      ]);
    });

    it("a class reads its blocks before any shared identity exists", async () => {
      const userId = await seedUser(tx);
      await seedClass(userId, "game");
      await upsert(userId, "game", "identity", "Name: Thorin");

      const blocks = await tx((trx) => store.getCoreMemoryBlocks(trx, userId, "game"));
      expect(blocks).toEqual([{ profileClass: "game", key: "identity", content: "Name: Thorin" }]);
    });

    it("rejects a block for a class the user hasn't registered", async () => {
      const userId = await seedUser(tx);
      await expect(upsert(userId, "game", "preferences", "x")).rejects.toThrow();
    });

    it("deleting a class deletes its blocks and leaves the NULL-class ones", async () => {
      const userId = await seedUser(tx);
      await seedClass(userId, "game");
      await upsert(userId, null, "identity", "Name: Tim");
      await upsert(userId, "game", "identity", "Name: Thorin");
      await upsert(userId, "game", "preferences", "Dice");

      await tx((trx) => profileClassStore.deleteProfileClass(trx, userId, "game").then(expectOk));

      const rows = await db
        .select({ profileClass: coreMemoryBlocks.profileClass, key: coreMemoryBlocks.key })
        .from(coreMemoryBlocks)
        .where(eq(coreMemoryBlocks.userId, userId));
      expect(rows).toEqual([{ profileClass: null, key: "identity" }]);
    });

    it("deleteCoreMemoryBlock removes one class's block and nothing in another scope", async () => {
      const userId = await seedUser(tx);
      await seedClass(userId, "game");
      await upsert(userId, null, "identity", "Name: Tim");
      await upsert(userId, "game", "identity", "Name: Thorin");
      await upsert(userId, "game", "preferences", "Dice");

      const remove = () =>
        tx((trx) =>
          store.deleteCoreMemoryBlock(trx, { userId, profileClass: "game", key: "identity" }),
        );
      expect(await remove()).toBe(true);
      expect(await remove()).toBe(false);

      const blocks = await tx((trx) => store.getCoreMemoryBlocks(trx, userId, "game"));
      expect(blocks).toEqual([
        { profileClass: null, key: "identity", content: "Name: Tim" },
        { profileClass: "game", key: "preferences", content: "Dice" },
      ]);
    });

    it("listCoreMemoryKeys lists one class's own keys", async () => {
      const userId = await seedUser(tx);
      await seedClass(userId, "game");
      await seedClass(userId, "coder");
      await upsert(userId, null, "identity", "Name: Tim");
      await upsert(userId, "game", "preferences", "Dice");
      await upsert(userId, "game", "identity", "Name: Thorin");
      await upsert(userId, "coder", "active_projects", "Cogmo");

      expect(await tx((trx) => store.listCoreMemoryKeys(trx, userId, "game"))).toEqual([
        "identity",
        "preferences",
      ]);
      expect(await tx((trx) => store.listCoreMemoryKeys(trx, userId, "unused"))).toEqual([]);
    });

    it("returns empty array for unknown user", async () => {
      const blocks = await tx((trx) =>
        store.getCoreMemoryBlocks(trx, "00000000-0000-0000-0000-000000000000", null),
      );
      expect(blocks).toEqual([]);
    });

    it("stamps a replaced block with its transaction's database time", async () => {
      // Snapshots and turn contexts are timed by the same clock, so a change
      // reads as before or after them.
      const userId = await seedUser(tx);
      await upsert(userId, null, "identity", "Name: Tim");

      const { updatedAt, now } = await tx(async (trx) => {
        const {
          rows: [{ now }],
        } = z
          .object({ rows: z.tuple([z.object({ now: z.coerce.date() })]) })
          .parse(await trx.execute(sql`SELECT now() AS now`));
        await store.upsertCoreMemoryBlock(trx, {
          userId,
          profileClass: null,
          key: "identity",
          content: "Name: Tim\nHome: Lisbon",
        });
        const [row] = await trx
          .select({ updatedAt: coreMemoryBlocks.updatedAt })
          .from(coreMemoryBlocks)
          .where(eq(coreMemoryBlocks.userId, userId));
        return { updatedAt: expectDefined(row, "block").updatedAt, now };
      });

      expect(updatedAt).toEqual(now);
    });

    it("lists when each of the user's blocks last changed, in every scope", async () => {
      const userId = await seedUser(tx);
      const otherUser = await seedUser(tx);
      await seedClass(userId, "game");
      await upsert(userId, null, "identity", "Name: Tim");
      await upsert(userId, "game", "preferences", "Dice");
      await upsert(otherUser, null, "identity", "Name: Ada");

      const times = await tx((trx) => store.getCoreMemoryUpdateTimes(trx, userId));

      expect(times.map(({ profileClass, key }) => ({ profileClass, key }))).toEqual(
        expect.arrayContaining([
          { profileClass: null, key: "identity" },
          { profileClass: "game", key: "preferences" },
        ]),
      );
      expect(times).toHaveLength(2);
      expect(times.every((t) => t.updatedAt instanceof Date)).toBe(true);
    });
  });
});
