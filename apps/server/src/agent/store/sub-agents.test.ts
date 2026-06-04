import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { UniqueViolationError } from "./errors.js";
import { DrizzleAgentStore } from "./index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleAgentStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleAgentStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

async function seedUser(): Promise<string> {
  return (await tx((trx) => store.createUser(trx))).id;
}

describe("DrizzleAgentStore sub-agents", () => {
  it("creates and lists a sub-agent", async () => {
    const userId = await seedUser();
    await tx((trx) =>
      store.createSubAgent(trx, {
        userId,
        name: "writer",
        description: "long-form prose",
        systemPrompt: "Be terse.",
        model: "claude-test",
      }),
    );
    const rows = await tx((trx) => store.listSubAgents(trx, userId));
    expect(rows).toHaveLength(1);
    expect(expectDefined(rows[0], "row")).toMatchObject({
      name: "writer",
      description: "long-form prose",
      systemPrompt: "Be terse.",
      model: "claude-test",
    });
  });

  it("stores a null system_prompt (pure model-as-tool)", async () => {
    const userId = await seedUser();
    await tx((trx) =>
      store.createSubAgent(trx, {
        userId,
        name: "reasoner",
        description: "hard reasoning",
        systemPrompt: null,
        model: "o3-test",
      }),
    );
    const rows = await tx((trx) => store.listSubAgents(trx, userId));
    expect(expectDefined(rows[0], "row").systemPrompt).toBeNull();
  });

  it("orders by name", async () => {
    const userId = await seedUser();
    for (const name of ["zed", "alpha", "mid"]) {
      await tx((trx) =>
        store.createSubAgent(trx, {
          userId,
          name,
          description: "d",
          systemPrompt: null,
          model: "m",
        }),
      );
    }
    const rows = await tx((trx) => store.listSubAgents(trx, userId));
    expect(rows.map((r) => r.name)).toEqual(["alpha", "mid", "zed"]);
  });

  it("rejects a duplicate (user_id, name) with UniqueViolationError", async () => {
    const userId = await seedUser();
    await tx((trx) =>
      store.createSubAgent(trx, {
        userId,
        name: "writer",
        description: "d",
        systemPrompt: null,
        model: "m",
      }),
    );
    await expect(
      tx((trx) =>
        store.createSubAgent(trx, {
          userId,
          name: "writer",
          description: "other",
          systemPrompt: null,
          model: "m2",
        }),
      ),
    ).rejects.toBeInstanceOf(UniqueViolationError);
  });

  it("scopes list + delete by user — same name under two users is allowed", async () => {
    const a = await seedUser();
    const b = await seedUser();
    for (const userId of [a, b]) {
      await tx((trx) =>
        store.createSubAgent(trx, {
          userId,
          name: "writer",
          description: "d",
          systemPrompt: null,
          model: "m",
        }),
      );
    }
    const del = await tx((trx) => store.deleteSubAgent(trx, b, "writer"));
    expect(del).toEqual({ deleted: true });
    expect(await tx((trx) => store.listSubAgents(trx, a))).toHaveLength(1);
    expect(await tx((trx) => store.listSubAgents(trx, b))).toHaveLength(0);
  });

  it("reports deleted:false when no row matches", async () => {
    const userId = await seedUser();
    expect(await tx((trx) => store.deleteSubAgent(trx, userId, "ghost"))).toEqual({
      deleted: false,
    });
  });
});
