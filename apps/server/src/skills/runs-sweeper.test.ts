/**
 * `sweepStuckRuns` over the real store on PGlite: which runs a sweep finishes
 * and as what, that a run moving on between the listing and its own UPDATE
 * is left alone, and that `skill-runs-sweeper` runs the sweep as its one
 * step, which a replay takes from its memoized result.
 */

import { InngestTestEngine } from "@inngest/test";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { profiles, users } from "../agent/store/schema.js";
import type { Database, Transactor } from "../db/index.js";
import { inngest } from "../inngest/client.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { createSkillRunsSweeper, sweepStuckRuns } from "./runs-sweeper.js";
import { DrizzleSkillStore, type SkillRunIdentity, type SkillStore } from "./store/index.js";
import { skillRuns } from "./store/schema.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleSkillStore();
let runAs: SkillRunIdentity;
let skillId: string;

const NOW = new Date("2026-06-01T10:00:00Z");

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  const [user] = await db.insert(users).values({}).returning({ id: users.id });
  const [profile] = await db
    .insert(profiles)
    .values({ userId: null, name: "default", basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  runAs = { userId: expectDefined(user, "user").id, profileId: expectDefined(profile, "p").id };
  const skill = await tx((trx) =>
    store.insertSkill(trx, {
      name: "echo",
      tier: "wasm",
      riskTier: "auto",
      effects: [],
      schedule: null,
      scheduleNextRunAt: null,
      scheduleRunAs: null,
      gitSha: "sha-1",
      lockfileHash: null,
      inputs: { type: "object", properties: {} },
      outputs: null,
    }),
  );
  skillId = skill.id;
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

/** A run created at `createdAt`, dispatched with `deadlineAt` when given. */
async function run(createdAt: string, deadlineAt?: string): Promise<string> {
  const inserted = await tx((trx) =>
    store.insertRun(trx, {
      skillId,
      trigger: "cron",
      inputs: {},
      gitSha: "sha-1",
      runAs,
    }),
  );
  await db
    .update(skillRuns)
    .set({ createdAt: new Date(createdAt) })
    .where(eq(skillRuns.id, inserted.id));
  if (deadlineAt !== undefined) {
    await tx((trx) =>
      store.transitionToDispatched(trx, { id: inserted.id, deadlineAt: new Date(deadlineAt) }),
    );
  }
  return inserted.id;
}

describe("sweepStuckRuns", () => {
  it("finishes a run started 15 min ago host_lost and one past its deadline result_lost", async () => {
    const neverDispatched = await run("2026-06-01T09:44:00Z");
    const lost = await run("2026-06-01T09:50:00Z", "2026-06-01T09:59:00Z");
    // Neither past its bound.
    const fresh = await run("2026-06-01T09:46:00Z");
    const inTime = await run("2026-06-01T09:30:00Z", "2026-06-01T10:01:00Z");

    const summary = await sweepStuckRuns({ store, runInTx: tx }, { now: NOW });

    expect(summary).toEqual({ hostLost: [neverDispatched], resultLost: [lost] });
    expect(await tx((trx) => store.getRun(trx, neverDispatched))).toMatchObject({
      recoveryPoint: "finished",
      status: "error",
      errorKind: "host_lost",
      error: "swept: no runtime dispatched the run within 15 min of its start",
      finishedAt: NOW,
      resourceUsage: { wallClockMs: 16 * 60 * 1000, peakMemoryBytes: null },
    });
    expect(await tx((trx) => store.getRun(trx, lost))).toMatchObject({
      recoveryPoint: "finished",
      status: "error",
      errorKind: "result_lost",
      error:
        "swept: the run was dispatched but reported no result by its deadline; the skill may have acted",
      resourceUsage: { wallClockMs: 10 * 60 * 1000, peakMemoryBytes: null },
    });
    expect(await tx((trx) => store.getRun(trx, fresh))).toMatchObject({ recoveryPoint: "started" });
    expect(await tx((trx) => store.getRun(trx, inTime))).toMatchObject({
      recoveryPoint: "dispatched",
    });
  });

  it("leaves a run whose own transition landed between the listing and the sweep", async () => {
    const id = await run("2026-06-01T09:00:00Z");
    // The run is listed stuck, then dispatched before the sweep's UPDATE.
    const racing = mock<Pick<SkillStore, "listStuckRuns" | "sweepRun">>();
    racing.listStuckRuns.mockImplementation((trx, params) => store.listStuckRuns(trx, params));
    racing.sweepRun.mockImplementation(async (trx, params) => {
      await store.transitionToDispatched(trx, { id, deadlineAt: new Date("2026-06-01T10:01:00Z") });
      return store.sweepRun(trx, params);
    });

    const summary = await sweepStuckRuns({ store: racing, runInTx: tx }, { now: NOW });

    expect(summary).toEqual({ hostLost: [], resultLost: [] });
    expect(await tx((trx) => store.getRun(trx, id))).toMatchObject({
      recoveryPoint: "dispatched",
      errorKind: null,
    });
  });

  it("finishes nothing when no run is stuck", async () => {
    expect(await sweepStuckRuns({ store, runInTx: tx }, { now: NOW })).toEqual({
      hostLost: [],
      resultLost: [],
    });
  });
});

describe("createSkillRunsSweeper", () => {
  it("runs the sweep as its one step", async () => {
    const stuck = await run("2026-01-01T00:00:00Z");
    const fn = createSkillRunsSweeper({ store, runInTx: tx }, inngest);

    const { result } = await new InngestTestEngine({
      function: fn,
      events: [{ name: "inngest/function.invoked", data: {} }],
    }).execute();

    expect(result).toEqual({ hostLost: [stuck], resultLost: [] });
  });

  it("returns a memoized sweep on replay without touching the store", async () => {
    const replayStore = mock<Pick<SkillStore, "listStuckRuns" | "sweepRun">>();
    const fn = createSkillRunsSweeper({ store: replayStore, runInTx: tx }, inngest);
    const memoized = { hostLost: ["run-1"], resultLost: [] };

    const { result } = await new InngestTestEngine({
      function: fn,
      events: [{ name: "inngest/function.invoked", data: {} }],
      steps: [{ id: "sweep", handler: () => memoized }],
    }).execute();

    expect(result).toEqual(memoized);
    expect(replayStore.listStuckRuns).not.toHaveBeenCalled();
    expect(replayStore.sweepRun).not.toHaveBeenCalled();
  });
});
