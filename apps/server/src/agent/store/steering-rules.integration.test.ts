/// <reference path="../../../test/vitest.d.ts" />

/**
 * The instruction-rule writes that rely on REPEATABLE READ, raced on two real
 * connections: PGlite has one, so the unit tier cannot. Each loser's snapshot
 * predates the winner's commit, so its conflicting statement fails with 40001
 * and the transactor's retry decides from the winner's committed row.
 */

import { randomBytes } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { err } from "neverthrow";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schemas.js";
import { type Transaction, transactor } from "../../db/transactor.js";
import { assertKind, expectDefined, expectOk } from "../../test/assertions.js";
import { fileDatabaseUrl, fileDefaultUserId } from "../../test/integration-file.js";
import { DrizzleAgentStore, type InstructionRuleParams } from "./index.js";
import { profiles, steeringRules } from "./schema.js";

const PREFIX = `it-${randomBytes(4).toString("hex")}-`;
const store = new DrizzleAgentStore();

let winnerSql: ReturnType<typeof postgres>;
let loserSql: ReturnType<typeof postgres>;
let observerSql: ReturnType<typeof postgres>;
let loserPid: number;
let profileId: string;

beforeAll(async () => {
  // One backend per client, so the loser's transaction runs on the pid polled below.
  winnerSql = postgres(fileDatabaseUrl(), { max: 1 });
  loserSql = postgres(fileDatabaseUrl(), { max: 1 });
  observerSql = postgres(fileDatabaseUrl(), { max: 1 });
  const [row] = await loserSql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  loserPid = expectDefined(row, "loser pid").pid;
  profileId = (
    await transactor(drizzle(observerSql, { schema }))((trx) =>
      store
        .createProfile(trx, {
          userId: null,
          name: `${PREFIX}profile`,
          basePrompt: "",
          model: "m",
          toolSet: [],
        })
        .then(expectOk),
    )
  ).id;
});

afterAll(async () => {
  await transactor(drizzle(observerSql, { schema }))(async (trx) => {
    await trx.delete(steeringRules).where(like(steeringRules.rule, `${PREFIX}%`));
    await trx.delete(profiles).where(eq(profiles.id, profileId));
  });
  await Promise.all([winnerSql.end(), loserSql.end(), observerSql.end()]);
});

/**
 * The winner runs `winner` and commits once `loser`, run through the
 * transactor, is waiting on a row the winner holds.
 */
async function race<W, L>(
  winner: (trx: Transaction) => Promise<W>,
  loser: (trx: Transaction) => Promise<L>,
) {
  let attempts = 0;
  const { won, outcome } = await drizzle(winnerSql, { schema }).transaction(async (trx) => {
    const won = await winner(trx);
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
    return { won, outcome };
  });
  return { won, lost: await outcome, attempts };
}

function instruction(rule: string): InstructionRuleParams {
  return {
    rule: `${PREFIX}${rule}`,
    category: "style",
    userId: fileDefaultUserId(),
    profileId: null,
    channelType: null,
    quote: rule,
  };
}

/** A live learned rule, committed before the race. */
async function learned(rule: string): Promise<string> {
  const [row] = await drizzle(observerSql, { schema })
    .insert(steeringRules)
    .values({
      rule: `${PREFIX}${rule}`,
      category: "style",
      active: true,
      source: "correction",
      priority: 100,
      observationCount: 2,
    })
    .returning({ id: steeringRules.id });
  return expectDefined(row, rule).id;
}

describe("instruction rules against a concurrent writer (real Postgres)", () => {
  it("setInstructionRule: the loser retries past 40001 onto the winner's row", async () => {
    const params = instruction("No bullet points.");
    const respelled = { ...params, rule: `${PREFIX}no  BULLET points. ` };

    const { won, lost, attempts } = await race(
      (trx) => store.setInstructionRule(trx, params),
      (trx) => store.setInstructionRule(trx, respelled),
    );

    if (won.kind !== "new") throw new Error(`expected the winner to write, got ${won.kind}`);
    expect(lost).toEqual({
      kind: "fulfilled",
      value: { kind: "existing", id: won.id, createdAt: won.createdAt },
    });
    expect(attempts).toBe(2);
  });

  it("replaceRules: a retirement committed during the merge rolls the group back", async () => {
    const kept = await learned("Keep it short.");
    const retiring = await learned("Be brief.");

    const { won, lost, attempts } = await race(
      (trx) =>
        store.retireRulesByText(trx, {
          text: `${PREFIX}Be brief.`,
          userId: fileDefaultUserId(),
          profileId,
          restricted: false,
        }),
      (trx) =>
        store.replaceRules(trx, {
          oldIds: [kept, retiring],
          newRule: {
            rule: `${PREFIX}Merged`,
            category: "style",
            profileId: null,
            channelType: null,
            priority: 100,
            observationCount: 4,
          },
        }),
    );

    expect(won.retired.map((r) => r.id)).toEqual([retiring]);
    // The first attempt's delete hits 40001; the retry's fresh snapshot finds
    // the group one rule short.
    assertKind(lost, "fulfilled");
    expect(lost.value).toEqual(err({ kind: "rule_group_changed", groupSize: 2, deleted: 1 }));
    expect(attempts).toBe(2);
    const survivors = await drizzle(observerSql, { schema })
      .select({ id: steeringRules.id, active: steeringRules.active })
      .from(steeringRules)
      .where(eq(steeringRules.rule, `${PREFIX}Keep it short.`));
    expect(survivors).toEqual([{ id: kept, active: true }]);
  });

  it("upsertCorrection: a reinforcement of a rule retired meanwhile writes nothing", async () => {
    const id = await learned("Use metric units.");

    const { lost, attempts } = await race(
      (trx) =>
        store.retireRulesByText(trx, {
          text: `${PREFIX}Use metric units.`,
          userId: fileDefaultUserId(),
          profileId,
          restricted: false,
        }),
      (trx) =>
        store.upsertCorrection(trx, {
          rule: `${PREFIX}Use metric units.`,
          category: "style",
          profileId: null,
          existingRuleId: id,
        }),
    );

    expect(lost).toEqual({ kind: "fulfilled", value: null });
    expect(attempts).toBe(2);
  });
});
