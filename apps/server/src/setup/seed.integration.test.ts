/// <reference path="../../test/vitest.d.ts" />

/**
 * The seed helpers raced on two real connections: PGlite has one, so the unit
 * tier cannot. The loser's REPEATABLE READ snapshot predates the winner's
 * commit, so its read misses the winner's row.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { profiles } from "../agent/store/schema.js";
import * as schema from "../db/schemas.js";
import { type Transactor, transactor } from "../db/transactor.js";
import { expectDefined } from "../test/assertions.js";
import { fileDatabaseUrl, fileDefaultUserId } from "../test/integration-file.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import { channels, userIdentities } from "../transport/store/schema.js";
import { ensureDefaultProfile, ensureWebChannel } from "./seed.js";

const agentStore = new DrizzleAgentStore();
const transportStore = new DrizzleTransportStore();

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
  // The file's database is seeded with the default profile and web channel,
  // which nothing references yet.
  await transactor(drizzle(observerSql, { schema }))(async (trx) => {
    await trx.delete(profiles);
    const [web] = await trx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.type, "web"));
    const { id } = expectDefined(web, "seeded web channel");
    await trx.delete(userIdentities).where(eq(userIdentities.channelId, id));
    await trx.delete(channels).where(eq(channels.id, id));
  });
});

afterAll(async () => {
  await Promise.all([winnerSql.end(), loserSql.end(), observerSql.end()]);
});

/**
 * `winner` runs in a transaction that commits once `loser`, run through the
 * transactor, is waiting on the uncommitted row or has settled without waiting.
 */
async function race<W, L>(
  winner: (runInTx: Transactor) => Promise<W>,
  loser: (runInTx: Transactor) => Promise<L>,
) {
  let attempts = 0;
  let settled = false;
  const loserTx = transactor(drizzle(loserSql, { schema }));
  const countingLoserTx: Transactor = (cb) =>
    loserTx((t) => {
      attempts += 1;
      return cb(t);
    });
  const { won, outcome } = await drizzle(winnerSql, { schema }).transaction(async (trx) => {
    const won = await winner((cb) => cb(trx));
    const outcome = loser(countingLoserTx)
      .then(
        (value) => ({ kind: "fulfilled" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      )
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(
      async () => {
        if (settled) return;
        const [activity] = await observerSql<{ wait: string | null }[]>`
          SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = ${loserPid}`;
        expect(activity?.wait).toBe("Lock");
      },
      { timeout: 5_000, interval: 10 },
    );
    return { won, outcome };
  });
  return { winner: won, loser: await outcome, attempts };
}

describe("seed helpers against a concurrent seed (real Postgres)", () => {
  it("ensureDefaultProfile: the loser retries past 40001 onto the winner's profile", async () => {
    const { winner, loser, attempts } = await race(
      (runInTx) => ensureDefaultProfile(runInTx, agentStore),
      (runInTx) => ensureDefaultProfile(runInTx, agentStore),
    );

    expect(loser).toEqual({ kind: "fulfilled", value: winner });
    expect(attempts).toBe(2);
    expect(await drizzle(observerSql, { schema }).$count(profiles)).toBe(1);
  });

  it("ensureWebChannel: the loser retries past 40001 onto the winner's channel", async () => {
    const userId = fileDefaultUserId();
    const { loser, attempts } = await race(
      (runInTx) => ensureWebChannel(runInTx, transportStore, userId),
      (runInTx) => ensureWebChannel(runInTx, transportStore, userId),
    );

    expect(loser).toEqual({ kind: "fulfilled", value: undefined });
    expect(attempts).toBe(2);
    const db = drizzle(observerSql, { schema });
    const [web] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.type, "web"));
    const { id } = expectDefined(web, "web channel");
    expect(await db.$count(channels, eq(channels.type, "web"))).toBe(1);
    expect(
      await db.$count(
        userIdentities,
        and(eq(userIdentities.channelId, id), eq(userIdentities.isWildcard, true)),
      ),
    ).toBe(1);
  });
});
