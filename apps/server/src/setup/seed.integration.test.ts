/// <reference path="../../test/vitest.d.ts" />

/**
 * `ensureDefaultProfile` raced on two real connections: PGlite has one, so the
 * unit tier cannot. The loser's REPEATABLE READ snapshot predates the winner's
 * commit, so its read misses the winner's profile.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { profiles } from "../agent/store/schema.js";
import * as schema from "../db/schemas.js";
import { type Transactor, transactor } from "../db/transactor.js";
import { expectDefined } from "../test/assertions.js";
import { fileDatabaseUrl } from "../test/integration-file.js";
import { ensureDefaultProfile } from "./seed.js";

const store = new DrizzleAgentStore();

let winnerSql: ReturnType<typeof postgres>;
let loserSql: ReturnType<typeof postgres>;
let observerSql: ReturnType<typeof postgres>;
let loserPid: number;

beforeAll(async () => {
  // One backend per client, so the loser's transaction runs on the pid polled below.
  winnerSql = postgres(fileDatabaseUrl(), { max: 1 });
  loserSql = postgres(fileDatabaseUrl(), { max: 1 });
  observerSql = postgres(fileDatabaseUrl(), { max: 1 });
  const [row] = await loserSql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  loserPid = expectDefined(row, "loser pid").pid;
  // The file's database is seeded with the default profile, which nothing references yet.
  await transactor(drizzle(observerSql, { schema }))((trx) => trx.delete(profiles));
});

afterAll(async () => {
  await Promise.all([winnerSql.end(), loserSql.end(), observerSql.end()]);
});

describe("ensureDefaultProfile against a concurrent seed (real Postgres)", () => {
  it("the loser retries past 40001 onto the winner's profile", async () => {
    let attempts = 0;
    const loserTx = transactor(drizzle(loserSql, { schema }));
    const countingLoserTx: Transactor = (cb) =>
      loserTx((t) => {
        attempts += 1;
        return cb(t);
      });

    // The winner seeds and commits once the loser is waiting on its uncommitted row.
    const { winner, outcome } = await drizzle(winnerSql, { schema }).transaction(async (trx) => {
      const winner = await ensureDefaultProfile((cb) => cb(trx), store);
      const outcome = ensureDefaultProfile(countingLoserTx, store).then(
        (value) => ({ kind: "fulfilled" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await vi.waitFor(
        async () => {
          const [activity] = await observerSql<{ wait: string | null }[]>`
            SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = ${loserPid}`;
          expect(activity?.wait).toBe("Lock");
        },
        { timeout: 5_000, interval: 10 },
      );
      return { winner, outcome };
    });

    expect(await outcome).toEqual({ kind: "fulfilled", value: winner });
    expect(attempts).toBe(2);
    expect(await drizzle(observerSql, { schema }).$count(profiles)).toBe(1);
  });
});
