/// <reference path="../../../test/vitest.d.ts" />

/**
 * Two session opens raced on two real connections against
 * `uq_sessions_active_address`: PGlite has one connection, so the unit tier
 * cannot. The loser's REPEATABLE READ snapshot predates the winner's commit,
 * so its keyed insert raises `40001` and the transactor retries it onto the
 * committed state (design/transport/sessions.md → Lifecycle).
 */

import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DrizzleAgentStore } from "../../agent/store/index.js";
import { conversations, profiles } from "../../agent/store/schema.js";
import { findPgErrorByCode } from "../../db/pg-errors.js";
import * as schema from "../../db/schemas.js";
import { type Transaction, transactor } from "../../db/transactor.js";
import { assertKind, expectDefined, expectOk } from "../../test/assertions.js";
import { fileDatabaseUrl, fileDefaultUserId } from "../../test/integration-file.js";
import { DrizzleTransportStore } from "./index.js";
import { channelSessions, channels } from "./schema.js";

const PREFIX = `it-${randomBytes(4).toString("hex")}-`;
const store = new DrizzleTransportStore();
const agentStore = new DrizzleAgentStore();

let winnerSql: ReturnType<typeof postgres>;
let loserSql: ReturnType<typeof postgres>;
let observerSql: ReturnType<typeof postgres>;
let loserPid: number;
let channelId: string;
let profileId: string;
let conversationIds: string[];

beforeAll(async () => {
  // One backend per client, so the loser's transaction runs on the pid polled below.
  winnerSql = postgres(fileDatabaseUrl(), { max: 1 });
  loserSql = postgres(fileDatabaseUrl(), { max: 1 });
  observerSql = postgres(fileDatabaseUrl(), { max: 1 });
  const [row] = await loserSql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  loserPid = expectDefined(row, "loser pid").pid;

  await transactor(drizzle(observerSql, { schema }))(async (trx) => {
    channelId = (
      await store.createChannel(trx, {
        type: `${PREFIX}channel`,
        credentials: {},
        identityMode: "mapped",
      })
    ).id;
    profileId = (
      await agentStore
        .createProfile(trx, {
          userId: null,
          name: `${PREFIX}profile`,
          basePrompt: "p",
          model: "m",
          toolSet: [],
        })
        .then(expectOk)
    ).id;
    const userId = fileDefaultUserId();
    conversationIds = [];
    for (const _ of [0, 1]) {
      const conv = await agentStore.createConversation(trx, { userId, profileId, isPrivate: true });
      conversationIds.push(conv.id);
    }
  });
});

afterAll(async () => {
  await transactor(drizzle(observerSql, { schema }))(async (trx) => {
    await trx.delete(channelSessions).where(eq(channelSessions.channelId, channelId));
    await trx.delete(channels).where(eq(channels.id, channelId));
    await trx.delete(conversations).where(inArray(conversations.id, conversationIds));
    await trx.delete(profiles).where(eq(profiles.id, profileId));
  });
  await Promise.all([winnerSql.end(), loserSql.end(), observerSql.end()]);
});

function conversation(index: 0 | 1): string {
  return expectDefined(conversationIds[index], "conversation");
}

/**
 * The winner swaps `platformAddress` onto conversation 0 and commits once
 * `loser`, run through the transactor, is waiting on the uncommitted row.
 */
async function race<T>(platformAddress: string, loser: (trx: Transaction) => Promise<T>) {
  let attempts = 0;
  const { winner, outcome } = await drizzle(winnerSql, { schema }).transaction(async (trx) => {
    const winner = await store.swapSession(trx, channelId, platformAddress, {
      conversationId: conversation(0),
      receive: "routed",
    });
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

async function activeIds(platformAddress: string): Promise<string[]> {
  const rows = await drizzle(observerSql, { schema })
    .select({ id: channelSessions.id })
    .from(channelSessions)
    .where(
      and(
        eq(channelSessions.channelId, channelId),
        eq(channelSessions.platformAddress, platformAddress),
        eq(channelSessions.status, "active"),
      ),
    );
  return rows.map((row) => row.id);
}

describe("session opens against a concurrent writer (real Postgres)", () => {
  it("swap vs swap: the loser retries past 40001 and closes the winner's row", async () => {
    const address = `${PREFIX}swap`;
    const { winner, loser, attempts } = await race(address, (trx) =>
      store.swapSession(trx, channelId, address, {
        conversationId: conversation(1),
        receive: "routed",
      }),
    );

    expect(winner.closedIds).toEqual([]);
    assertKind(loser, "fulfilled");
    expect(loser.value.closedIds).toEqual([winner.id]);
    expect(attempts).toBe(2);
    expect(await activeIds(address)).toEqual([loser.value.id]);
  });

  it("a plain insert, the control: the loser fails with 23505, which is not retried", async () => {
    const address = `${PREFIX}plain`;
    const { winner, loser, attempts } = await race(address, (trx) =>
      trx.insert(channelSessions).values({
        channelId,
        platformAddress: address,
        conversationId: conversation(1),
        status: "active",
        receive: "routed",
      }),
    );

    assertKind(loser, "rejected");
    expect(findPgErrorByCode(loser.error, ["23505"])).toMatchObject({
      constraint_name: "uq_sessions_active_address",
    });
    expect(attempts).toBe(1);
    expect(await activeIds(address)).toEqual([winner.id]);
  });
});
