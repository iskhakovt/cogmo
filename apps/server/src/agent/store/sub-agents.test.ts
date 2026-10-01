import { err } from "neverthrow";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleSubAgentStore } from "./sub-agents.js";
import { DrizzleUserStore } from "./users.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleSubAgentStore();
const userStore = new DrizzleUserStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

async function seedUser(): Promise<string> {
  return (await tx((trx) => userStore.createUser(trx))).id;
}

describe("DrizzleSubAgentStore", () => {
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

  it("rejects a duplicate (user_id, name) as sub_agent_name_taken", async () => {
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
    const dup = await tx((trx) =>
      store.createSubAgent(trx, {
        userId,
        name: "writer",
        description: "other",
        systemPrompt: null,
        model: "m2",
      }),
    );
    expect(dup).toEqual(err({ kind: "sub_agent_name_taken", name: "writer" }));
    const rows = await tx((trx) => store.listSubAgents(trx, userId));
    expect(rows.map((r) => r.description)).toEqual(["d"]);
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
