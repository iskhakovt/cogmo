/// <reference path="../../test/vitest.d.ts" />

/**
 * Two `migrateAndSeed` runs against one database, on real connections: PGlite
 * has one. The first pauses inside its user insert, after its read found no
 * user, until the second has finished or is waiting on the bootstrap lock.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type AgentStore, DrizzleAgentStore } from "../agent/store/index.js";
import { profiles, users } from "../agent/store/schema.js";
import * as schema from "../db/schemas.js";
import { transactor } from "../db/transactor.js";
import { fileDatabaseUrl } from "../test/integration-file.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import { channels, userIdentities } from "../transport/store/schema.js";
import { migrateAndSeed } from "./migrate-and-seed.js";

let firstSql: ReturnType<typeof postgres>;
let secondSql: ReturnType<typeof postgres>;
let observerSql: ReturnType<typeof postgres>;

beforeAll(async () => {
  firstSql = postgres(fileDatabaseUrl());
  secondSql = postgres(fileDatabaseUrl());
  observerSql = postgres(fileDatabaseUrl(), { max: 1 });
  // The file's database is seeded; nothing references the seeded rows yet.
  await transactor(drizzle(observerSql, { schema }))(async (trx) => {
    await trx.delete(userIdentities);
    await trx.delete(channels);
    await trx.delete(profiles);
    await trx.delete(users);
  });
});

afterAll(async () => {
  await Promise.all([firstSql.end(), secondSql.end(), observerSql.end()]);
});

function run(sql: ReturnType<typeof postgres>, agentStore: AgentStore) {
  const db = drizzle(sql, { schema });
  return migrateAndSeed(
    {
      sql,
      db,
      runInTx: transactor(db),
      agentStore,
      transportStore: new DrizzleTransportStore(),
    },
    { reset: null },
  );
}

describe("migrateAndSeed against a concurrent run (real Postgres)", () => {
  it("a run that starts mid-seed lands on the first run's rows", async () => {
    let secondDone = false;
    const firstAtInsert = Promise.withResolvers<void>();
    const gated = new DrizzleAgentStore();
    const plain = new DrizzleAgentStore();
    vi.spyOn(gated, "createUser").mockImplementationOnce(async (tx) => {
      firstAtInsert.resolve();
      await vi.waitFor(
        async () => {
          if (secondDone) return;
          const waiting = await observerSql`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
          expect(waiting).toHaveLength(1);
        },
        { timeout: 10_000, interval: 10 },
      );
      return plain.createUser(tx);
    });

    const first = run(firstSql, gated);
    await firstAtInsert.promise;
    const second = run(secondSql, plain).finally(() => {
      secondDone = true;
    });
    const [firstSeeded, secondSeeded] = await Promise.all([first, second]);

    expect(secondSeeded).toEqual(firstSeeded);
    const db = drizzle(observerSql, { schema });
    expect(await db.$count(users)).toBe(1);
    expect(await db.$count(profiles)).toBe(1);
    expect(await db.$count(channels, eq(channels.type, "direct"))).toBe(1);
    expect(await db.$count(channels, eq(channels.type, "web"))).toBe(1);
  });
});
