import { err } from "neverthrow";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { seedUser } from "../../test/agent-store-fixtures.js";
import { expectOk } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleProfileClassStore } from "./profile-classes.js";
import { DrizzleProfileStore } from "./profiles.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleProfileClassStore();
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

describe("DrizzleProfileClassStore", () => {
  describe("profile classes", () => {
    async function seedClassed(): Promise<{ userId: string; profileId: string }> {
      const userId = await seedUser(tx);
      const profile = await tx((trx) =>
        profileStore
          .createProfile(trx, {
            userId,
            name: "intimate",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      return { userId, profileId: profile.id };
    }

    it("creates a class and lists it", async () => {
      const { userId } = await seedClassed();
      const created = await tx((trx) =>
        store
          .createProfileClass(trx, {
            userId,
            name: "intimate",
            description: "for emotional / relationship topics",
          })
          .then(expectOk),
      );
      expect(created.name).toBe("intimate");
      const list = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(list).toHaveLength(1);
      expect(list[0]?.description).toBe("for emotional / relationship topics");
    });

    it("rejects duplicate class name within the same user", async () => {
      const { userId } = await seedClassed();
      await tx((trx) =>
        store
          .createProfileClass(trx, { userId, name: "intimate", description: "first" })
          .then(expectOk),
      );
      const dup = await tx((trx) =>
        store.createProfileClass(trx, { userId, name: "intimate", description: "second" }),
      );
      expect(dup).toEqual(err({ kind: "profile_class_name_taken", name: "intimate" }));
    });

    it("rejects class names that don't match the canonical shape", async () => {
      const { userId } = await seedClassed();
      // Same canonical-name regex enforced for profile classes — keeps
      // the merged "label registry" surface uniform with compartments.
      for (const name of ["Intimate", "two words"]) {
        const created = await tx((trx) =>
          store.createProfileClass(trx, { userId, name, description: "x" }),
        );
        expect(created).toEqual(err({ kind: "invalid_name", name, subject: "profile_class" }));
      }
    });

    it("setProfileClass attaches a registered class", async () => {
      const { userId, profileId } = await seedClassed();
      await tx((trx) =>
        store
          .createProfileClass(trx, { userId, name: "intimate", description: "x" })
          .then(expectOk),
      );
      await tx((trx) => profileStore.setProfileClass(trx, profileId, "intimate").then(expectOk));
      const profile = await tx((trx) => profileStore.getProfile(trx, profileId));
      expect(profile?.profileClass).toBe("intimate");
    });

    it("setProfileClass with null clears the class", async () => {
      const { userId, profileId } = await seedClassed();
      await tx((trx) =>
        store
          .createProfileClass(trx, { userId, name: "intimate", description: "x" })
          .then(expectOk),
      );
      await tx((trx) => profileStore.setProfileClass(trx, profileId, "intimate").then(expectOk));
      await tx((trx) => profileStore.setProfileClass(trx, profileId, null).then(expectOk));
      const profile = await tx((trx) => profileStore.getProfile(trx, profileId));
      expect(profile?.profileClass).toBeNull();
    });

    it("setProfileClass refuses an unregistered class and leaves the tx usable", async () => {
      const { profileId } = await seedClassed();
      const result = await tx(async (trx) => {
        const set = await profileStore.setProfileClass(trx, profileId, "no-such-class");
        await profileStore.updateProfile(trx, profileId, { basePrompt: "after" }).then(expectOk);
        return set;
      });
      expect(result).toEqual(err({ kind: "unknown_profile_class", name: "no-such-class" }));
      const profile = await tx((trx) => profileStore.getProfile(trx, profileId));
      expect(profile).toMatchObject({ profileClass: null, basePrompt: "after" });
    });

    it("setProfileClass on an org profile (userId=null) rejects any non-null class", async () => {
      // Create an org profile (userId=null).
      const orgProfile = await tx((trx) =>
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
      expect(
        await tx((trx) => profileStore.setProfileClass(trx, orgProfile.id, "anything")),
      ).toEqual(err({ kind: "unknown_profile_class", name: "anything" }));
    });

    it("deleteProfileClass refuses a class a profile references", async () => {
      const { userId, profileId } = await seedClassed();
      await tx((trx) =>
        store
          .createProfileClass(trx, { userId, name: "intimate", description: "x" })
          .then(expectOk),
      );
      await tx((trx) => profileStore.setProfileClass(trx, profileId, "intimate").then(expectOk));
      expect(await tx((trx) => store.deleteProfileClass(trx, userId, "intimate"))).toEqual(
        err({ kind: "profile_class_in_use", profileRefs: 1 }),
      );
      expect(await tx((trx) => store.listProfileClasses(trx, userId))).toHaveLength(1);
    });

    it("deleteProfileClass succeeds after the references are cleared", async () => {
      const { userId, profileId } = await seedClassed();
      await tx((trx) =>
        store
          .createProfileClass(trx, { userId, name: "intimate", description: "x" })
          .then(expectOk),
      );
      await tx((trx) => profileStore.setProfileClass(trx, profileId, "intimate").then(expectOk));
      await tx((trx) => profileStore.setProfileClass(trx, profileId, null).then(expectOk));
      const result = await tx((trx) =>
        store.deleteProfileClass(trx, userId, "intimate").then(expectOk),
      );
      expect(result.deleted).toBe(true);
      const list = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(list).toHaveLength(0);
    });

    it("deleteProfileClass returns deleted:false for an unknown name (idempotent)", async () => {
      const { userId } = await seedClassed();
      const result = await tx((trx) =>
        store.deleteProfileClass(trx, userId, "no-such").then(expectOk),
      );
      expect(result.deleted).toBe(false);
    });

    it("createProfileClass defaults restricted=false; listProfileClasses surfaces it", async () => {
      const { userId } = await seedClassed();
      const created = await tx((trx) =>
        store
          .createProfileClass(trx, { userId, name: "intimate", description: "x" })
          .then(expectOk),
      );
      expect(created.restricted).toBe(false);
      const list = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(list[0]?.restricted).toBe(false);
    });

    it("setProfileClassRestricted flips the flag and is idempotent", async () => {
      const { userId } = await seedClassed();
      await tx((trx) =>
        store
          .createProfileClass(trx, { userId, name: "intimate", description: "x" })
          .then(expectOk),
      );
      const first = await tx((trx) =>
        store.setProfileClassRestricted(trx, userId, "intimate", true),
      );
      expect(first.updated).toBe(true);
      const after = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(after[0]?.restricted).toBe(true);
      // Re-flipping to the same value is a no-op success — idempotent.
      const second = await tx((trx) =>
        store.setProfileClassRestricted(trx, userId, "intimate", true),
      );
      expect(second.updated).toBe(true);
      const off = await tx((trx) =>
        store.setProfileClassRestricted(trx, userId, "intimate", false),
      );
      expect(off.updated).toBe(true);
      const final = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(final[0]?.restricted).toBe(false);
    });

    it("setProfileClassRestricted returns updated:false for an unknown name", async () => {
      const { userId } = await seedClassed();
      const result = await tx((trx) =>
        store.setProfileClassRestricted(trx, userId, "no-such", true),
      );
      expect(result.updated).toBe(false);
    });

    it("setProfileClassRestricted is independent of in-use status — restricting an attached class works", async () => {
      const { userId, profileId } = await seedClassed();
      await tx((trx) =>
        store
          .createProfileClass(trx, { userId, name: "intimate", description: "x" })
          .then(expectOk),
      );
      await tx((trx) => profileStore.setProfileClass(trx, profileId, "intimate").then(expectOk));
      const result = await tx((trx) =>
        store.setProfileClassRestricted(trx, userId, "intimate", true),
      );
      expect(result.updated).toBe(true);
      const list = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(list[0]?.restricted).toBe(true);
    });
  });
});
