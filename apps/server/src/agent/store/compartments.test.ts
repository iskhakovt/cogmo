import { err } from "neverthrow";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { expectOk } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleCompartmentStore } from "./compartments.js";
import { seedUser } from "./test-fixtures.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleCompartmentStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("DrizzleCompartmentStore", () => {
  describe("custom compartments", () => {
    it("creates and lists, ordered by name", async () => {
      const userId = await seedUser(tx);
      await tx((trx) =>
        store
          .createCustomCompartment(trx, { userId, name: "music", description: "music notes" })
          .then(expectOk),
      );
      await tx((trx) =>
        store
          .createCustomCompartment(trx, { userId, name: "dnd", description: "dnd campaign" })
          .then(expectOk),
      );
      const list = await tx((trx) => store.listCustomCompartments(trx, userId));
      expect(list.map((c) => c.name)).toEqual(["dnd", "music"]);
    });

    it("rejects names that don't match the canonical shape", async () => {
      const userId = await seedUser(tx);
      // Uppercase, leading non-letter, special chars, too long, whitespace,
      // empty. Trailing hyphens / underscores are intentionally accepted —
      // the regex permits anything from the [a-z0-9_-] class after the
      // leading letter, so `dnd-` is valid (matches `compartment:dnd-` as a
      // tag value, even if it reads oddly).
      const badNames = ["Work", "1campaign", "dnd!", "x".repeat(33), "two words", "", "-leading"];
      for (const name of badNames) {
        const created = await tx((trx) =>
          store.createCustomCompartment(trx, { userId, name, description: "x" }),
        );
        expect(created).toEqual(err({ kind: "invalid_name", name, subject: "compartment" }));
      }
    });

    it("accepts canonical-shape names (lowercase + digits + - / _)", async () => {
      const userId = await seedUser(tx);
      const ok = ["dnd", "music-prod", "side_project", "campaign1", "a"];
      for (const name of ok) {
        await tx((trx) =>
          store.createCustomCompartment(trx, { userId, name, description: "x" }).then(expectOk),
        );
      }
      const list = await tx((trx) => store.listCustomCompartments(trx, userId));
      expect(list.map((c) => c.name).sort()).toEqual([...ok].sort());
    });

    it("rejects core-compartment names as reserved", async () => {
      const userId = await seedUser(tx);
      for (const name of ["personal", "misc"]) {
        const created = await tx((trx) =>
          store.createCustomCompartment(trx, { userId, name, description: "shadow" }),
        );
        expect(created).toEqual(err({ kind: "compartment_name_reserved", name }));
      }
    });

    it("rejects duplicates within the same user", async () => {
      const userId = await seedUser(tx);
      await tx((trx) =>
        store
          .createCustomCompartment(trx, { userId, name: "dnd", description: "first" })
          .then(expectOk),
      );
      const dup = await tx((trx) =>
        store.createCustomCompartment(trx, { userId, name: "dnd", description: "second" }),
      );
      expect(dup).toEqual(err({ kind: "compartment_name_taken", name: "dnd" }));
    });

    it("enforces the per-user cap and reports current count on overflow", async () => {
      const userId = await seedUser(tx);
      for (let i = 0; i < 10; i++) {
        await tx((trx) =>
          store
            .createCustomCompartment(trx, {
              userId,
              name: `c${i}`,
              description: `desc-${i}`,
            })
            .then(expectOk),
        );
      }
      const overflow = await tx((trx) =>
        store.createCustomCompartment(trx, { userId, name: "overflow", description: "x" }),
      );
      expect(overflow).toEqual(err({ kind: "compartment_cap_exceeded", limit: 10, current: 10 }));
    });

    it("delete is forward-only and idempotent on unknown names", async () => {
      const userId = await seedUser(tx);
      await tx((trx) =>
        store
          .createCustomCompartment(trx, { userId, name: "dnd", description: "x" })
          .then(expectOk),
      );
      const r1 = await tx((trx) => store.deleteCustomCompartment(trx, userId, "dnd"));
      expect(r1.deleted).toBe(true);
      const r2 = await tx((trx) => store.deleteCustomCompartment(trx, userId, "dnd"));
      expect(r2.deleted).toBe(false);
    });

    it("scopes by user — one user's compartments are not visible to another", async () => {
      const u1 = await seedUser(tx);
      const u2 = await seedUser(tx);
      await tx((trx) =>
        store
          .createCustomCompartment(trx, { userId: u1, name: "dnd", description: "x" })
          .then(expectOk),
      );
      const list1 = await tx((trx) => store.listCustomCompartments(trx, u1));
      const list2 = await tx((trx) => store.listCustomCompartments(trx, u2));
      expect(list1.map((c) => c.name)).toEqual(["dnd"]);
      expect(list2).toHaveLength(0);
    });
  });
});
