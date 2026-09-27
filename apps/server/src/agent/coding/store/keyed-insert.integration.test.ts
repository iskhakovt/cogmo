/// <reference path="../../../../test/vitest.d.ts" />

/**
 * The keyed-insert rule in `.claude/rules/inngest.md`, raced on two real
 * connections: PGlite has one, so the unit tier cannot. Each loser's
 * REPEATABLE READ snapshot predates the winner's commit.
 */

import { randomBytes } from "node:crypto";
import { like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { findPgErrorByCode } from "../../../db/pg-errors.js";
import * as schema from "../../../db/schemas.js";
import { type Transaction, transactor } from "../../../db/transactor.js";
import { assertKind, expectDefined } from "../../../test/assertions.js";
import { DrizzleCodingStore, type InsertRepoParams } from "./index.js";
import { codingRepos } from "./schema.js";

const PREFIX = `it-${randomBytes(4).toString("hex")}-`;
const store = new DrizzleCodingStore();

let winnerSql: ReturnType<typeof postgres>;
let loserSql: ReturnType<typeof postgres>;
let observerSql: ReturnType<typeof postgres>;
let loserPid: number;

beforeAll(async () => {
  // One backend per client, so the loser's transaction runs on the pid polled below.
  winnerSql = postgres(inject("databaseUrl"), { max: 1 });
  loserSql = postgres(inject("databaseUrl"), { max: 1 });
  observerSql = postgres(inject("databaseUrl"), { max: 1 });
  const [row] = await loserSql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  loserPid = expectDefined(row, "loser pid").pid;
});

afterAll(async () => {
  await transactor(drizzle(observerSql, { schema }))((trx) =>
    trx.delete(codingRepos).where(like(codingRepos.name, `${PREFIX}%`)),
  );
  await Promise.all([winnerSql.end(), loserSql.end(), observerSql.end()]);
});

function repo(tag: string): InsertRepoParams {
  return {
    name: `${PREFIX}${tag}`,
    localPath: `/srv/${tag}`,
    defaultBranch: "main",
    remoteUrl: "git@github.com:it/keyed-insert.git",
    devcontainer: null,
    allowedBackends: ["claude"],
    verifyCommand: "true",
    taskTokenBudget: 1000,
    taskWallTimeSeconds: 60,
    maxConcurrentTasks: 1,
  };
}

/**
 * The winner inserts `params` and commits once `loser`, run through the
 * transactor, is waiting on the uncommitted row.
 */
async function race<T>(params: InsertRepoParams, loser: (trx: Transaction) => Promise<T>) {
  let attempts = 0;
  const { winner, outcome } = await drizzle(winnerSql, { schema }).transaction(async (trx) => {
    const winner = await store.insertOrRecoverRepo(trx, params);
    const outcome = transactor(drizzle(loserSql, { schema }))((t) => {
      attempts += 1;
      return loser(t);
    }).then(
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
  return { winner, loser: await outcome, attempts };
}

describe("keyed insert against a concurrent writer (real Postgres)", () => {
  it("insertOrRecoverRepo: the loser retries past 40001 onto the winner's row", async () => {
    const params = repo("keyed");
    const { winner, loser, attempts } = await race(params, (trx) =>
      store.insertOrRecoverRepo(trx, params),
    );

    expect(winner.kind).toBe("new");
    expect(loser).toEqual({ kind: "fulfilled", value: { kind: "recovered", row: winner.row } });
    expect(attempts).toBe(2);
  });

  it("insertRepo, the control: the loser fails with 23505, which is not retried", async () => {
    const params = repo("plain");
    const { loser, attempts } = await race(params, (trx) => store.insertRepo(trx, params));

    assertKind(loser, "rejected");
    expect(findPgErrorByCode(loser.error, ["23505"])).toMatchObject({
      constraint_name: "coding_repos_name_unique",
    });
    expect(attempts).toBe(1);
  });
});
