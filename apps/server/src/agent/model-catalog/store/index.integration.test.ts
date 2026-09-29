/// <reference path="../../../../test/vitest.d.ts" />

/**
 * `DrizzleModelCatalogStore` against real Postgres (postgres-js), with the
 * table the migration creates rather than `pushSchema`'s. The unit tier runs
 * the same calls on PGlite; what only the production driver shows is the
 * full-size JSONB round trip (a live refresh writes about 3,000 entries) and
 * `jsonb_object_keys` over the stored row.
 */
import { sql as rawSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { transactor } from "../../../db/index.js";
import * as schema from "../../../db/schemas.js";
import { bundledSnapshot } from "../../../llm/litellm-data.js";
import { expectDefined } from "../../../test/assertions.js";
import { fileDatabaseUrl } from "../../../test/integration-file.js";
import { DrizzleModelCatalogStore } from "./index.js";

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let tx: ReturnType<typeof transactor>;
const store = new DrizzleModelCatalogStore();

beforeAll(() => {
  sql = postgres(fileDatabaseUrl(), { max: 2 });
  db = drizzle(sql, { schema });
  tx = transactor(db);
});

afterEach(async () => {
  await db.execute(rawSql`DELETE FROM model_catalogs`);
});

afterAll(async () => {
  await sql.end();
});

describe("DrizzleModelCatalogStore (real Postgres)", () => {
  it("round-trips a full-size catalog and lists its ids", async () => {
    const catalog = bundledSnapshot();

    const stored = await tx((trx) => store.replace(trx, catalog));
    const latest = expectDefined(await tx((trx) => store.latest(trx)), "latest");
    const ids = expectDefined(await tx((trx) => store.latestModelIds(trx)), "ids");

    expect(latest.id).toBe(stored.id);
    expect(latest.createdAt).toEqual(stored.createdAt);
    expect(latest.entries).toEqual(catalog);
    expect(ids.toSorted()).toEqual(Object.keys(catalog).toSorted());
  });

  it("keeps only the newest catalog", async () => {
    await tx((trx) =>
      store.replace(trx, { a: { contextWindow: 100_000, maxOutputTokens: 4_096 } }),
    );
    const newer = await tx((trx) =>
      store.replace(trx, { b: { contextWindow: 200_000, maxOutputTokens: 8_192 } }),
    );

    const rows = await db.execute(rawSql`SELECT id FROM model_catalogs`);
    expect(rows.map((row) => row.id)).toEqual([newer.id]);
    expect(await tx((trx) => store.latestModelIds(trx))).toEqual(["b"]);
  });

  it("lists no ids for a row whose entries aren't an object, and replaces it", async () => {
    await db.execute(rawSql`INSERT INTO model_catalogs (entries) VALUES ('[1, 2]'::jsonb)`);
    expect(await tx((trx) => store.latestModelIds(trx))).toBeNull();

    const catalog = { a: { contextWindow: 100_000, maxOutputTokens: 4_096 } };
    await tx((trx) => store.replace(trx, catalog));
    expect(expectDefined(await tx((trx) => store.latest(trx)), "latest").entries).toEqual(catalog);
  });

  it("lists the ids of a row that no longer parses", async () => {
    // Written under an older schema, bypassing the store's write-side parse.
    await db.execute(
      rawSql`INSERT INTO model_catalogs (entries) VALUES (${JSON.stringify({ m: { contextWindow: "big" } })}::jsonb)`,
    );

    await expect(tx((trx) => store.latest(trx))).rejects.toBeInstanceOf(z.ZodError);
    expect(await tx((trx) => store.latestModelIds(trx))).toEqual(["m"]);
  });
});
