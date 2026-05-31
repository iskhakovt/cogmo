import { InngestTestEngine } from "@inngest/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../db/index.js";
import { inngest } from "../inngest/client.js";
import type { StepRun } from "../inngest/index.js";
import { fakeRunInTx, spyOnInngestSend } from "../test/factories.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { createSkillCronTicker, runSkillCronTick } from "./cron-ticker.js";
import { DrizzleSkillStore, type InsertSkillParams, type SkillStore } from "./store/index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleSkillStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleSkillStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

// Same shim as scheduling/ticker.test.ts — strips Inngest's JSON memoization
// round-trip so Date instances survive into the test body.
const stepRun = ((_: string, fn: () => Promise<unknown>) => fn()) as unknown as StepRun;

const SHA = "0123456789abcdef0123456789abcdef01234567";

async function seedScheduled(overrides: Partial<InsertSkillParams> = {}) {
  return tx((trx) =>
    store.insertSkill(trx, {
      name: overrides.name ?? "morning-brief",
      tier: "wasm",
      riskTier: "auto",
      effects: [],
      schedule: overrides.schedule ?? "0 9 * * *",
      scheduleNextRunAt: overrides.scheduleNextRunAt ?? new Date("2026-06-01T09:00:00Z"),
      gitSha: SHA,
      lockfileHash: null,
      inputs: { type: "object", properties: {} },
      outputs: null,
      ...overrides,
    }),
  );
}

describe("runSkillCronTick", () => {
  it("returns no events when nothing is due", async () => {
    await seedScheduled({ scheduleNextRunAt: new Date("2099-01-01T00:00:00Z") });

    const events = await runSkillCronTick(
      {
        runInTx: tx,
        store,
        userTimezone: "UTC",
        now: () => new Date("2026-06-01T09:00:00Z"),
      },
      stepRun,
    );
    expect(events).toEqual([]);
  });

  it("emits one event per due row in next_run_at order, carrying skillId/skillName/gitSha", async () => {
    const a = await seedScheduled({
      name: "later",
      schedule: "30 8 * * *",
      scheduleNextRunAt: new Date("2026-06-01T08:30:00Z"),
    });
    const b = await seedScheduled({
      name: "earlier",
      schedule: "0 8 * * *",
      scheduleNextRunAt: new Date("2026-06-01T08:00:00Z"),
    });

    const events = await runSkillCronTick(
      {
        runInTx: tx,
        store,
        userTimezone: "UTC",
        now: () => new Date("2026-06-01T09:00:00Z"),
      },
      stepRun,
    );

    expect(events.map((e) => e.skillId)).toEqual([b.id, a.id]);
    expect(events[0]).toEqual({
      skillId: b.id,
      skillName: "earlier",
      gitSha: SHA,
      scheduledFor: "2026-06-01T08:00:00.000Z",
    });
    expect(events[1]?.skillName).toBe("later");
  });

  it("advances next_run_at to the first occurrence AFTER now() — skip-ahead, no backfill", async () => {
    // Cron fires daily at 09:00 UTC. next_run_at is 3 days in the past;
    // now() is 2026-06-04T08:00. One fire and next_run_at skips to 09:00
    // the same day (the first occurrence after now()).
    const row = await seedScheduled({
      scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
    });

    const events = await runSkillCronTick(
      {
        runInTx: tx,
        store,
        userTimezone: "UTC",
        now: () => new Date("2026-06-04T08:00:00Z"),
      },
      stepRun,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.scheduledFor).toBe("2026-06-01T09:00:00.000Z");

    const after = await tx((trx) => store.getSkillById(trx, row.id));
    expect(after?.nextRunAt?.toISOString()).toBe("2026-06-04T09:00:00.000Z");
    expect(after?.lastFiredAt?.toISOString()).toBe("2026-06-01T09:00:00.000Z");
  });

  it("event scheduledFor uses the row's stale fire time, not now()", async () => {
    // Regression guard: the lateness signal lives in `scheduledFor` —
    // operators reading skill_runs match it against `created_at` to spot
    // catch-up fires. A future bug swapping row.nextRunAt for `now` here
    // would silently make every fire look on-time.
    const stale = new Date("2026-06-01T09:00:00Z");
    await seedScheduled({ scheduleNextRunAt: stale });

    const now = new Date("2026-06-04T08:00:00Z");
    const events = await runSkillCronTick(
      { runInTx: tx, store, userTimezone: "UTC", now: () => now },
      stepRun,
    );
    expect(events[0]?.scheduledFor).toBe(stale.toISOString());
    expect(events[0]?.scheduledFor).not.toBe(now.toISOString());
  });

  it("skips disabled rows even when next_run_at is in the past", async () => {
    const row = await seedScheduled({
      scheduleNextRunAt: new Date("2026-01-01T09:00:00Z"),
    });
    await tx((trx) => store.setSkillDisabled(trx, { id: row.id, disabled: true }));

    const events = await runSkillCronTick(
      {
        runInTx: tx,
        store,
        userTimezone: "UTC",
        now: () => new Date("2026-06-01T09:00:00Z"),
      },
      stepRun,
    );
    expect(events).toEqual([]);
  });

  it("honours the batchSize cap", async () => {
    await seedScheduled({
      name: "a",
      schedule: "0 1 * * *",
      scheduleNextRunAt: new Date("2026-01-01T01:00:00Z"),
    });
    await seedScheduled({
      name: "b",
      schedule: "0 2 * * *",
      scheduleNextRunAt: new Date("2026-01-01T02:00:00Z"),
    });
    await seedScheduled({
      name: "c",
      schedule: "0 3 * * *",
      scheduleNextRunAt: new Date("2026-01-01T03:00:00Z"),
    });

    const events = await runSkillCronTick(
      {
        runInTx: tx,
        store,
        userTimezone: "UTC",
        now: () => new Date("2026-06-01T09:00:00Z"),
        batchSize: 2,
      },
      stepRun,
    );
    expect(events).toHaveLength(2);
  });

  it("throws loudly if the store yields a row with schedule=null (defense in depth)", async () => {
    // The DB CHECK + partial index reject this, so it should be unreachable.
    // A future shape drift that bypasses the store layer would otherwise
    // silently advance next_run_at to itself; the explicit throw stops that.
    const fakeStore = mock<Pick<SkillStore, "lockDueScheduledSkills" | "advanceSkillSchedule">>();
    fakeStore.lockDueScheduledSkills.mockResolvedValue([
      {
        id: "skill-malformed",
        name: "malformed",
        tier: "wasm",
        riskTier: "auto",
        effects: [],
        schedule: null,
        nextRunAt: new Date("2026-06-01T09:00:00Z"),
        lastFiredAt: null,
        gitSha: SHA,
        lockfileHash: null,
        inputs: { type: "object", properties: {} },
        outputs: null,
        disabled: false,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
    ]);

    await expect(
      runSkillCronTick(
        {
          runInTx: tx,
          store: fakeStore,
          userTimezone: "UTC",
          now: () => new Date("2026-06-01T09:30:00Z"),
        },
        stepRun,
      ),
    ).rejects.toThrow(/invariant violated/);
    expect(fakeStore.advanceSkillSchedule).not.toHaveBeenCalled();
  });
});

describe("createSkillCronTicker (Inngest wiring)", () => {
  let sendSpy: ReturnType<typeof spyOnInngestSend>;
  beforeEach(() => {
    sendSpy = spyOnInngestSend(inngest);
    sendSpy.mockResolvedValue({ ids: ["fake"] });
  });
  afterEach(() => {
    sendSpy.mockRestore();
  });

  it("pins the function configuration (cron, retries, concurrency)", () => {
    const fn = createSkillCronTicker(
      {
        runInTx: fakeRunInTx,
        store: mock<SkillStore>(),
        userTimezone: "UTC",
      },
      inngest,
    );
    expect(fn.opts.id).toBe("skill-cron-ticker");
    expect(fn.opts.retries).toBe(0);
    expect(fn.opts.concurrency).toEqual({ limit: 1 });
    expect(fn.opts.triggers).toEqual([{ cron: "* * * * *" }]);
  });

  it("emits one event per due row with idempotency key '<skillId>:<scheduledFor>'", async () => {
    // The event id is the Inngest event-bus dedup mechanism — regressions
    // that drop or alter the key shape produce silent double-fires.
    const fakeStore = mock<SkillStore>();
    fakeStore.lockDueScheduledSkills.mockResolvedValue([
      {
        id: "skill-A",
        name: "alpha",
        tier: "wasm",
        riskTier: "auto",
        effects: [],
        schedule: "0 9 * * *",
        nextRunAt: new Date("2026-06-01T08:00:00Z"),
        lastFiredAt: null,
        gitSha: SHA,
        lockfileHash: null,
        inputs: { type: "object", properties: {} },
        outputs: null,
        disabled: false,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
      {
        id: "skill-B",
        name: "beta",
        tier: "container",
        riskTier: "notify",
        effects: ["reads_filesystem"],
        schedule: "30 9 * * *",
        nextRunAt: new Date("2026-06-01T08:30:00Z"),
        lastFiredAt: null,
        gitSha: SHA,
        lockfileHash: null,
        inputs: { type: "object", properties: {} },
        outputs: null,
        disabled: false,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
    ]);
    fakeStore.advanceSkillSchedule.mockResolvedValue(undefined);

    const fn = createSkillCronTicker(
      {
        runInTx: tx,
        store: fakeStore,
        userTimezone: "UTC",
        now: () => new Date("2026-06-01T09:00:00Z"),
      },
      inngest,
    );

    await new InngestTestEngine({
      function: fn,
      events: [{ name: "inngest/function.invoked", data: {} } as never],
    }).execute();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0]?.[0] as {
      payload: Array<{ id: string; data: { skillId: string; scheduledFor: string } }>;
    };
    expect(call.payload).toHaveLength(2);
    expect(call.payload.map((e) => e.id)).toEqual([
      "skill-A:2026-06-01T08:00:00.000Z",
      "skill-B:2026-06-01T08:30:00.000Z",
    ]);
    for (const event of call.payload) {
      expect(event.id).toBe(`${event.data.skillId}:${event.data.scheduledFor}`);
    }
  });

  it("does NOT re-run lock-and-advance when Inngest replays with a cached step result", async () => {
    // Replay-safety: a ticker retry that finds `lock-and-advance` cached
    // must NOT call lockDueScheduledSkills again — that would double-lock +
    // double-advance the same rows whose state has already moved on.
    const fakeStore = mock<SkillStore>();
    fakeStore.lockDueScheduledSkills.mockResolvedValue([]);

    const fn = createSkillCronTicker(
      {
        runInTx: tx,
        store: fakeStore,
        userTimezone: "UTC",
        now: () => new Date(),
      },
      inngest,
    );

    const cachedEvents = [
      {
        skillId: "skill-cached",
        skillName: "cached",
        gitSha: SHA,
        scheduledFor: "2026-06-01T09:00:00.000Z",
      },
    ];
    await new InngestTestEngine({
      function: fn,
      events: [{ name: "inngest/function.invoked", data: {} } as never],
      steps: [{ id: "lock-and-advance", handler: () => cachedEvents }],
    }).execute();

    expect(fakeStore.lockDueScheduledSkills).not.toHaveBeenCalled();
    expect(fakeStore.advanceSkillSchedule).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
