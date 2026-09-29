import { count, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database, Transactor } from "../../../db/index.js";
import type { LitellmCatalog } from "../../../llm/litellm-data.js";
import { expectDefined } from "../../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../../test/pglite.js";
import { DrizzleModelCatalogStore } from "./index.js";
import { modelCatalogs } from "./schema.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleModelCatalogStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

const first: LitellmCatalog = {
  "claude-sonnet-5": { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
};
const second: LitellmCatalog = {
  ...first,
  "claude-sonnet-5-5": { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
};

async function rowCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(modelCatalogs);
  return expectDefined(row, "count").n;
}

describe("DrizzleModelCatalogStore", () => {
  it("has no catalog before the first replace", async () => {
    expect(await tx((trx) => store.latest(trx))).toBeNull();
  });

  it("returns what replace stored, with its id and fetch time", async () => {
    const stored = await tx((trx) => store.replace(trx, first));
    const latest = expectDefined(await tx((trx) => store.latest(trx)), "latest");
    expect(latest).toEqual({ id: stored.id, entries: first, createdAt: stored.createdAt });
  });

  it("keeps only the newest catalog", async () => {
    await tx((trx) => store.replace(trx, first));
    const newer = await tx((trx) => store.replace(trx, second));

    const latest = expectDefined(await tx((trx) => store.latest(trx)), "latest");
    expect(latest.id).toBe(newer.id);
    expect(latest.entries).toEqual(second);
    expect(await rowCount()).toBe(1);
  });

  it("rejects an entry the schema doesn't accept, leaving the stored catalog", async () => {
    await tx((trx) => store.replace(trx, first));
    const bad = { m: { contextWindow: 0, maxOutputTokens: 4_096 } };
    await expect(tx((trx) => store.replace(trx, bad))).rejects.toThrow();

    const latest = expectDefined(await tx((trx) => store.latest(trx)), "latest");
    expect(latest.entries).toEqual(first);
  });

  it("lists the newest catalog's model ids, none before the first replace", async () => {
    expect(await tx((trx) => store.latestModelIds(trx))).toBeNull();
    await tx((trx) => store.replace(trx, first));
    await tx((trx) => store.replace(trx, second));
    const ids = await tx((trx) => store.latestModelIds(trx));
    expect(ids?.toSorted()).toEqual(["claude-sonnet-5", "claude-sonnet-5-5"]);
  });

  it("lists no ids for a row whose entries aren't an object", async () => {
    await db.execute(sql`INSERT INTO model_catalogs (entries) VALUES ('[1, 2]'::jsonb)`);
    expect(await tx((trx) => store.latestModelIds(trx))).toBeNull();
  });

  it("replaces a row that no longer parses", async () => {
    await db.execute(
      sql`INSERT INTO model_catalogs (entries) VALUES (${JSON.stringify({ m: { contextWindow: "big" } })}::jsonb)`,
    );
    await tx((trx) => store.replace(trx, first));
    const latest = expectDefined(await tx((trx) => store.latest(trx)), "latest");
    expect(latest.entries).toEqual(first);
    expect(await rowCount()).toBe(1);
  });

  it("fails the read when a stored row no longer parses, while its ids still list", async () => {
    // Bypasses the write-side parse: a row written under an older schema.
    await db.execute(
      sql`INSERT INTO model_catalogs (entries) VALUES (${JSON.stringify({ m: { contextWindow: "big" } })}::jsonb)`,
    );
    await expect(tx((trx) => store.latest(trx))).rejects.toBeInstanceOf(z.ZodError);
    expect(await tx((trx) => store.latestModelIds(trx))).toEqual(["m"]);
  });
});
