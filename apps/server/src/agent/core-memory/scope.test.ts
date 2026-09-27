import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transactor } from "../../db/index.js";
import { createTestDatabase } from "../../test/pglite.js";
import { DrizzleAgentStore } from "../store/index.js";
import { readCoreMemory } from "./scope.js";

describe("readCoreMemory (PGlite)", () => {
  let runInTx: Transactor;
  let close: () => Promise<void>;
  let userId: string;
  const store = new DrizzleAgentStore();

  beforeAll(async () => {
    ({ tx: runInTx, close } = await createTestDatabase());
    userId = (await runInTx((tx) => store.createUser(tx))).id;
    await runInTx(async (tx) => {
      await store.createProfileClass(tx, { userId, name: "game", description: "x" });
      await store.upsertCoreMemoryBlock(tx, {
        userId,
        profileClass: null,
        key: "identity",
        content: "Name: Sam",
      });
      await store.upsertCoreMemoryBlock(tx, {
        userId,
        profileClass: "game",
        key: "identity",
        content: "Name: Thorin",
      });
      await store.upsertCoreMemoryBlock(tx, {
        userId,
        profileClass: "game",
        key: "active_projects",
        content: "- The campaign",
      });
    });
  });

  afterAll(async () => {
    await close();
  });

  it("gives a restricted class its identity override", async () => {
    const view = await runInTx((tx) =>
      readCoreMemory(tx, store, userId, {
        kind: "classed",
        profileClass: "game",
        restricted: true,
      }),
    );

    expect(view.blocks).toEqual([
      { profileClass: null, key: "identity", content: "Name: Sam" },
      { profileClass: "game", key: "identity", content: "Name: Thorin" },
      { profileClass: "game", key: "active_projects", content: "- The campaign" },
    ]);
  });

  it("leaves out an unrestricted class's identity, so only the shared one renders", async () => {
    const view = await runInTx((tx) =>
      readCoreMemory(tx, store, userId, {
        kind: "classed",
        profileClass: "game",
        restricted: false,
      }),
    );

    expect(view.blocks).toEqual([
      { profileClass: null, key: "identity", content: "Name: Sam" },
      { profileClass: "game", key: "active_projects", content: "- The campaign" },
    ]);
  });
});
