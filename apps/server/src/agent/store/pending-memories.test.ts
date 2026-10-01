import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { seedUser } from "../../test/agent-store-fixtures.js";
import { expectDefined, expectOk } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzlePendingMemoryStore } from "./pending-memories.js";
import { DrizzleProfileClassStore } from "./profile-classes.js";
import { DrizzleProfileStore } from "./profiles.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzlePendingMemoryStore();
const profileClassStore = new DrizzleProfileClassStore();
const profileStore = new DrizzleProfileStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("DrizzlePendingMemoryStore", () => {
  describe("pending_memories", () => {
    it("stages a row with content + source and returns its id", async () => {
      const userId = await seedUser(tx);

      const { id } = await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "homelab IP is 10.0.10.10",
          source: "live_retain",
        }),
      );

      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id,
        content: "homelab IP is 10.0.10.10",
        context: null,
        source: "live_retain",
        profileClass: null,
        skillName: null,
      });
      expect(rows[0]!.createdAt).toBeInstanceOf(Date);
    });

    it("stages a skill's row naming the skill", async () => {
      const userId = await seedUser(tx);

      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "the build is green",
          source: "skill",
          skillName: "ci_watch",
        }),
      );

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows).toMatchObject([{ source: "skill", skillName: "ci_watch" }]);
    });

    it("types a skill row as naming its skill, and bulk staging as refusing skill rows", () => {
      type StageParams = Parameters<DrizzlePendingMemoryStore["stagePendingMemory"]>[1];
      type BulkRow = Parameters<DrizzlePendingMemoryStore["bulkStagePendingMemories"]>[1][number];
      // @ts-expect-error — a skill row names its skill
      const nameless: StageParams = { userId: "u", profileId: null, content: "x", source: "skill" };
      // @ts-expect-error — a bulk stage takes no skill rows
      const bulkSkill: BulkRow = { userId: "u", content: "x", source: "skill" };
      expect([nameless, bulkSkill]).toHaveLength(2);
    });

    it("getPendingMemories surfaces the staging profile's CURRENT class via JOIN", async () => {
      // Regression for the speaker-isolation leak: rows staged by
      // profile A must drain with A's class, not the class of whichever
      // conversation triggered the Observer fire. The JOIN reads the
      // profile's current class so a class rename re-flows pending rows
      // without a backfill.
      const userId = await seedUser(tx);
      // Seed a class and a profile bound to it.
      await tx((trx) =>
        profileClassStore
          .createProfileClass(trx, {
            userId,
            name: "intimate",
            description: "for emotional / relationship topics",
          })
          .then(expectOk),
      );
      const profile = await tx((trx) =>
        profileStore
          .createProfile(trx, {
            userId,
            name: "intimate-profile",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      await tx((trx) => profileStore.setProfileClass(trx, profile.id, "intimate").then(expectOk));

      // Stage a pending row tied to that profile.
      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: profile.id,
          content: "we made up after the argument",
          source: "live_retain",
        }),
      );
      // And another with no profile lineage (migration-style).
      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "wife's birthday is March 15",
          source: "migration",
        }),
      );

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows).toHaveLength(2);
      const intimate = rows.find((r) => r.content === "we made up after the argument");
      const legacy = rows.find((r) => r.content === "wife's birthday is March 15");
      expect(intimate?.profileClass).toBe("intimate");
      expect(legacy?.profileClass).toBeNull();
      expect(intimate?.profileId).toBe(profile.id);
      expect(legacy?.profileId).toBeNull();
    });

    it("getPendingMemories scopes the profile JOIN by user_id — no cross-user class contamination", async () => {
      // Defence in depth: if a `pending_memories.profile_id` ever
      // points at a profile owned by a different user (manual SQL,
      // future bug, restored backup), the JOIN must NOT surface that
      // user's `profile_class`. The composite predicate
      // (profiles.id = pm.profile_id AND profiles.user_id = pm.user_id)
      // makes such rows fall through to the LEFT JOIN's NULL on the
      // class dimension.
      const userA = await seedUser(tx);
      const userB = await seedUser(tx);
      // Create a class + profile under userB.
      await tx((trx) =>
        profileClassStore
          .createProfileClass(trx, { userId: userB, name: "intimate", description: "x" })
          .then(expectOk),
      );
      const profileB = await tx((trx) =>
        profileStore
          .createProfile(trx, {
            userId: userB,
            name: "p",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      await tx((trx) => profileStore.setProfileClass(trx, profileB.id, "intimate").then(expectOk));
      // Stage a pending row for userA but maliciously pointing at userB's profile.
      // This shape can't arise via the supported store API, but we simulate
      // it via a raw insert to test the JOIN's defence.
      await db.execute(sql`
        INSERT INTO pending_memories (user_id, profile_id, content, source)
        VALUES (${userA}::uuid, ${profileB.id}::uuid, 'cross-user payload', 'live_retain')
      `);

      const rows = await tx((trx) => store.getPendingMemories(trx, userA));
      expect(rows).toHaveLength(1);
      // Class MUST NOT leak across the user boundary even though the
      // profile_id points at a real (other-user) profile with a class.
      expect(rows[0]?.profileClass).toBeNull();
      // Nor does the profile, whose memory rules the drain would apply.
      expect(rows[0]?.profileId).toBeNull();
    });

    it("getPendingMemories filters before its limit, so excluded rows never fill a batch", async () => {
      const userId = await seedUser(tx);
      const mk = (name: string) =>
        tx((trx) =>
          profileStore
            .createProfile(trx, { userId, name, basePrompt: "p", model: "m", toolSet: [] })
            .then(expectOk),
        );
      const own = await mk("third-party");
      const other = await mk("main");
      for (let i = 0; i < 101; i++) {
        await tx((trx) =>
          store.stagePendingMemory(trx, {
            userId,
            profileId: other.id,
            content: `first-party fact ${i}`,
            source: "live_retain",
          }),
        );
      }
      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: own.id,
          content: "staged by the third-party profile",
          source: "live_retain",
        }),
      );
      const filter = { stagedBy: own.id };

      const batch = await tx((trx) => store.getPendingMemories(trx, userId, 100, filter));
      const unfiltered = await tx((trx) => store.getPendingMemories(trx, userId, 100));

      expect(batch.map((r) => r.content)).toEqual(["staged by the third-party profile"]);
      expect(unfiltered.map((r) => r.profileId)).not.toContain(own.id);
      expect(await tx((trx) => store.countPendingMemories(trx, userId))).toBe(102);
      expect(await tx((trx) => store.countPendingMemories(trx, userId, filter))).toBe(1);
      expect(
        await tx((trx) => store.countPendingMemories(trx, userId, { sources: ["migration"] })),
      ).toBe(0);
      const [first] = unfiltered;
      const byId = await tx((trx) =>
        store.getPendingMemories(trx, userId, undefined, { ids: [expectDefined(first, "row").id] }),
      );
      expect(byId).toHaveLength(1);
    });

    it("getPendingMemories surfaces an org staging profile, which has no class", async () => {
      const userId = await seedUser(tx);
      const org = await tx((trx) =>
        profileStore
          .createProfile(trx, {
            userId: null,
            name: "org",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: org.id,
          content: "staged by the org profile",
          source: "live_retain",
        }),
      );

      const [row] = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(row?.profileId).toBe(org.id);
      expect(row?.profileClass).toBeNull();
    });

    it("getPendingMemories surfaces the staging profile's CURRENT class — re-flows on reassignment", async () => {
      // Documents the JOIN's read-current-class semantic: the pending
      // row stores `profile_id`, NOT a snapshot of `profile_class`. So
      // changing the profile's class (via setProfileClass) before the
      // drain runs means the row picks up the new class label on its
      // next read — no backfill of pending rows needed when the user
      // reorganises which profile belongs to which class.
      const userId = await seedUser(tx);
      await tx((trx) =>
        profileClassStore
          .createProfileClass(trx, { userId, name: "intimate", description: "x" })
          .then(expectOk),
      );
      await tx((trx) =>
        profileClassStore
          .createProfileClass(trx, { userId, name: "general", description: "y" })
          .then(expectOk),
      );
      const profile = await tx((trx) =>
        profileStore
          .createProfile(trx, {
            userId,
            name: "p",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      await tx((trx) => profileStore.setProfileClass(trx, profile.id, "intimate").then(expectOk));
      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: profile.id,
          content: "fact staged under intimate",
          source: "live_retain",
        }),
      );
      const before = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(before[0]?.profileClass).toBe("intimate");

      // Reassign the profile to a different class — the pending row's
      // profile_id is unchanged, but the JOIN now resolves to "general".
      await tx((trx) => profileStore.setProfileClass(trx, profile.id, "general").then(expectOk));
      const after = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(after[0]?.profileClass).toBe("general");

      // Clearing the class on the profile drops the row to untagged on
      // the class dimension — drain stamps no profile_class:* tag.
      await tx((trx) => profileStore.setProfileClass(trx, profile.id, null).then(expectOk));
      const cleared = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(cleared[0]?.profileClass).toBeNull();
    });

    it("preserves optional context", async () => {
      const userId = await seedUser(tx);

      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "wife's birthday is March 15",
          context: "while planning a gift",
          source: "live_retain",
        }),
      );

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows[0]?.context).toBe("while planning a gift");
    });

    it("returns rows ordered oldest-first (FIFO)", async () => {
      const userId = await seedUser(tx);

      const { id: first } = await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "first",
          source: "live_retain",
        }),
      );
      // Brief delay so created_at differs measurably under PGlite.
      await new Promise((r) => setTimeout(r, 5));
      const { id: second } = await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "second",
          source: "migration",
        }),
      );

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows.map((r) => r.id)).toEqual([first, second]);
    });

    it("respects the limit parameter and returns the oldest rows first", async () => {
      const userId = await seedUser(tx);

      for (let i = 0; i < 5; i++) {
        await tx((trx) =>
          store.stagePendingMemory(trx, {
            userId,
            profileId: null,
            content: `fact ${i}`,
            source: "live_retain",
          }),
        );
        await new Promise((r) => setTimeout(r, 2));
      }

      const limited = await tx((trx) => store.getPendingMemories(trx, userId, 2));
      expect(limited).toHaveLength(2);
      expect(limited.map((r) => r.content)).toEqual(["fact 0", "fact 1"]);

      const unbounded = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(unbounded).toHaveLength(5);
    });

    it("scopes rows by userId — never returns another user's pending rows", async () => {
      const userA = await seedUser(tx);
      const userB = await seedUser(tx);

      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId: userA,
          profileId: null,
          content: "A's fact",
          source: "live_retain",
        }),
      );
      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId: userB,
          profileId: null,
          content: "B's fact",
          source: "live_retain",
        }),
      );

      const rowsA = await tx((trx) => store.getPendingMemories(trx, userA));
      const rowsB = await tx((trx) => store.getPendingMemories(trx, userB));
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]?.content).toBe("A's fact");
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0]?.content).toBe("B's fact");
    });

    it("deletes specified rows by id", async () => {
      const userId = await seedUser(tx);

      const a = await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "fact A",
          source: "live_retain",
        }),
      );
      const b = await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "fact B",
          source: "live_retain",
        }),
      );

      await tx((trx) => store.deletePendingMemories(trx, [a.id]));

      const remaining = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(remaining.map((r) => r.id)).toEqual([b.id]);
    });

    it("deletePendingMemories with empty list is a no-op", async () => {
      const userId = await seedUser(tx);

      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "fact",
          source: "live_retain",
        }),
      );

      await tx((trx) => store.deletePendingMemories(trx, []));

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows).toHaveLength(1);
    });

    it("bulk-stages multiple rows in one statement", async () => {
      const userId = await seedUser(tx);

      await tx((trx) =>
        store.bulkStagePendingMemories(trx, [
          { userId, content: "fact A", source: "migration" },
          { userId, content: "fact B", context: "with context", source: "migration" },
          { userId, content: "fact C", source: "migration" },
        ]),
      );

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.content).sort()).toEqual(["fact A", "fact B", "fact C"]);
      expect(rows.find((r) => r.content === "fact B")?.context).toBe("with context");
      expect(rows.every((r) => r.source === "migration")).toBe(true);
    });

    it("bulkStagePendingMemories with empty array is a no-op", async () => {
      const userId = await seedUser(tx);

      await tx((trx) => store.bulkStagePendingMemories(trx, []));

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows).toEqual([]);
    });

    it("rejects unknown source values", async () => {
      const userId = await seedUser(tx);

      await expect(
        tx((trx) =>
          store.stagePendingMemory(trx, {
            userId,
            profileId: null,
            content: "fact",
            source: "bogus" as any,
          }),
        ),
      ).rejects.toThrow();
    });
  });
});
