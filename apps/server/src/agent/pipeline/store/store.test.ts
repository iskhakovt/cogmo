import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../../db/index.js";
import { createTestDatabase, truncateAll } from "../../../test/pglite.js";
import { DrizzleAgentStore } from "../../store/index.js";
import { validPipelineDefinition } from "../test-fixtures.js";
import { DrizzlePipelineStore } from "./index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzlePipelineStore;
let agentStore: DrizzleAgentStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzlePipelineStore();
  agentStore = new DrizzleAgentStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

async function createUser(): Promise<string> {
  return (await tx((trx) => agentStore.createUser(trx))).id;
}

async function insertDefinition(userId: string, name = "issue-to-pr") {
  return tx((trx) =>
    store.insertDefinition(trx, {
      userId,
      name,
      sourceText: "on command, gather context, gate, implement",
      compiled: { ...validPipelineDefinition(), name },
    }),
  );
}

describe("DrizzlePipelineStore", () => {
  it("inserts version 1 inactive, then increments per (user, name)", async () => {
    const userId = await createUser();
    const v1 = await insertDefinition(userId);
    expect(v1.version).toBe(1);
    expect(v1.active).toBe(false);

    const v2 = await insertDefinition(userId);
    expect(v2.version).toBe(2);

    // A different name starts back at 1.
    const other = await insertDefinition(userId, "other-pipeline");
    expect(other.version).toBe(1);
  });

  it("round-trips the compiled definition through jsonbZod", async () => {
    const userId = await createUser();
    const row = await insertDefinition(userId);
    const fetched = await tx((trx) => store.getDefinition(trx, row.id));
    expect(fetched?.compiled).toEqual({ ...validPipelineDefinition(), name: "issue-to-pr" });
  });

  it("getDefinitionByName returns the latest version unless pinned", async () => {
    const userId = await createUser();
    await insertDefinition(userId);
    const v2 = await insertDefinition(userId);

    const latest = await tx((trx) => store.getDefinitionByName(trx, userId, "issue-to-pr"));
    expect(latest?.id).toBe(v2.id);

    const pinned = await tx((trx) => store.getDefinitionByName(trx, userId, "issue-to-pr", 1));
    expect(pinned?.version).toBe(1);
  });

  it("activateDefinition flips the old version off and the new one on in one tx", async () => {
    const userId = await createUser();
    const v1 = await insertDefinition(userId);
    const v2 = await insertDefinition(userId);

    const first = await tx((trx) => store.activateDefinition(trx, userId, v1.id));
    expect(first).toEqual({ kind: "activated", name: "issue-to-pr", version: 1 });

    const second = await tx((trx) => store.activateDefinition(trx, userId, v2.id));
    expect(second).toEqual({ kind: "activated", name: "issue-to-pr", version: 2 });

    const rows = await tx((trx) => store.listDefinitions(trx, userId));
    expect(rows.filter((r) => r.active).map((r) => r.version)).toEqual([2]);
  });

  it("reports already_active idempotently", async () => {
    const userId = await createUser();
    const v1 = await insertDefinition(userId);
    await tx((trx) => store.activateDefinition(trx, userId, v1.id));
    const again = await tx((trx) => store.activateDefinition(trx, userId, v1.id));
    expect(again).toEqual({ kind: "already_active", name: "issue-to-pr", version: 1 });
  });

  it("activateDefinition is ownership-checked", async () => {
    const owner = await createUser();
    const intruder = await createUser();
    const row = await insertDefinition(owner);
    const result = await tx((trx) => store.activateDefinition(trx, intruder, row.id));
    expect(result).toEqual({ kind: "not_found" });
  });

  it("the partial unique index rejects a second active row for the same name", async () => {
    const userId = await createUser();
    const v1 = await insertDefinition(userId);
    const v2 = await insertDefinition(userId);
    await tx((trx) => store.activateDefinition(trx, userId, v1.id));

    // Bypass the store's deactivate-then-activate to prove the DB-level
    // invariant holds on its own. Drizzle wraps the PG error as "Failed
    // query: ..." with the duplicate-key detail on `cause`, so assert there.
    const { pipelineDefinitions } = await import("./schema.js");
    const { eq } = await import("drizzle-orm");
    const error = await tx((trx) =>
      trx
        .update(pipelineDefinitions)
        .set({ active: true })
        .where(eq(pipelineDefinitions.id, v2.id)),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const cause = error instanceof Error ? (error.cause ?? error) : error;
    expect(String(cause)).toMatch(/duplicate key|uq_pipeline_definitions_active/);
  });

  it("countDefinitions counts all versions, scoped per user", async () => {
    const userId = await createUser();
    const otherUser = await createUser();
    await insertDefinition(userId);
    await insertDefinition(userId);
    await insertDefinition(otherUser, "other");
    expect(await tx((trx) => store.countDefinitions(trx, userId))).toBe(2);
    expect(await tx((trx) => store.countDefinitions(trx, otherUser))).toBe(1);
  });

  it("listDefinitions orders by name then version desc, scoped per user", async () => {
    const userId = await createUser();
    const otherUser = await createUser();
    await insertDefinition(userId, "beta");
    await insertDefinition(userId, "beta");
    await insertDefinition(userId, "alpha");
    await insertDefinition(otherUser, "gamma");

    const rows = await tx((trx) => store.listDefinitions(trx, userId));
    expect(rows.map((r) => [r.name, r.version])).toEqual([
      ["alpha", 1],
      ["beta", 2],
      ["beta", 1],
    ]);
  });
});
