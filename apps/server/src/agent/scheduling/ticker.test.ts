import { InngestTestEngine } from "@inngest/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../../db/index.js";
import { inngest } from "../../inngest/client.js";
import type { StepRun } from "../../inngest/index.js";
import { fakeRunInTx, spyOnInngestSend } from "../../test/factories.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import type { AgentStore } from "../store/index.js";
import { DrizzleAgentStore } from "../store/index.js";
import { createScheduledTaskTicker, runScheduledTaskTick } from "./ticker.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleAgentStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleAgentStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

// Inline step.run shim — same pattern as cleanup-orphan-run-branches.test.ts.
// Strips Inngest's JSON memoization round-trip (preserves Date instances).
const stepRun = ((_: string, fn: () => Promise<unknown>) => fn()) as unknown as StepRun;

async function seedUserAndProfile(): Promise<{ userId: string; profileId: string }> {
  const userId = (await tx((trx) => store.createUser(trx))).id;
  const profileId = (
    await tx((trx) =>
      store.createProfile(trx, {
        userId,
        name: "test",
        basePrompt: "be helpful",
        model: "claude-test",
        toolSet: [],
      }),
    )
  ).id;
  return { userId, profileId };
}

async function seedRecurring(
  userId: string,
  profileId: string,
  overrides: Partial<{
    nextRunAt: Date;
    cron: string;
    catchupMissed: boolean;
    enabled: boolean;
    prompt: string;
  }> = {},
) {
  return tx((trx) =>
    store.createScheduledTask(trx, {
      userId,
      profileId,
      kind: "recurring",
      cron: overrides.cron ?? "0 9 * * *",
      timezone: "UTC",
      prompt: overrides.prompt ?? "morning briefing",
      nextRunAt: overrides.nextRunAt ?? new Date("2026-06-01T09:00:00Z"),
      enabled: overrides.enabled ?? true,
      catchupMissed: overrides.catchupMissed ?? false,
      source: "wizard",
    }),
  );
}

async function seedOneOff(userId: string, profileId: string, nextRunAt: Date) {
  return tx((trx) =>
    store.createScheduledTask(trx, {
      userId,
      profileId,
      kind: "one_off",
      cron: null,
      timezone: "UTC",
      prompt: "one off",
      nextRunAt,
      enabled: true,
      catchupMissed: false,
      source: "agent",
    }),
  );
}

describe("runScheduledTaskTick", () => {
  it("returns no events when nothing is due", async () => {
    const { userId, profileId } = await seedUserAndProfile();
    await seedRecurring(userId, profileId, { nextRunAt: new Date("2099-01-01T00:00:00Z") });

    const events = await runScheduledTaskTick(
      { runInTx: tx, store, now: () => new Date("2026-06-01T09:00:00Z") },
      stepRun,
    );
    expect(events).toEqual([]);
  });

  it("emits a fan-out payload for each due row, in next_run_at order", async () => {
    const { userId, profileId } = await seedUserAndProfile();
    const t1 = await seedRecurring(userId, profileId, {
      nextRunAt: new Date("2026-06-01T08:00:00Z"),
      prompt: "earlier",
    });
    const t2 = await seedRecurring(userId, profileId, {
      cron: "0 10 * * *",
      nextRunAt: new Date("2026-06-01T08:30:00Z"),
      prompt: "later",
    });

    const events = await runScheduledTaskTick(
      { runInTx: tx, store, now: () => new Date("2026-06-01T09:00:00Z") },
      stepRun,
    );

    expect(events.map((e) => e.taskId)).toEqual([t1.id, t2.id]);
    expect(events[0]).toEqual({
      taskId: t1.id,
      userId,
      profileId,
      scheduledFor: "2026-06-01T08:00:00.000Z",
      prompt: "earlier",
    });
    expect(events[1]?.prompt).toBe("later");
  });

  it("advances next_run_at to the first occurrence AFTER now() by default (catchup_missed=false)", async () => {
    const { userId, profileId } = await seedUserAndProfile();
    // Cron fires daily at 09:00 UTC. next_run_at is 3 days in the past;
    // now() is 2026-06-04T08:00. We want one fire and then skip to the
    // first occurrence after now() = 2026-06-04T09:00.
    const task = await seedRecurring(userId, profileId, {
      nextRunAt: new Date("2026-06-01T09:00:00Z"),
    });

    const events = await runScheduledTaskTick(
      { runInTx: tx, store, now: () => new Date("2026-06-04T08:00:00Z") },
      stepRun,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.scheduledFor).toBe("2026-06-01T09:00:00.000Z");

    const after = await tx((trx) => store.getScheduledTask(trx, task.id));
    expect(after?.nextRunAt.toISOString()).toBe("2026-06-04T09:00:00.000Z");
    expect(after?.lastRunAt?.toISOString()).toBe("2026-06-01T09:00:00.000Z");
    expect(after?.enabled).toBe(true);
  });

  it("advances next_run_at one occurrence at a time when catchup_missed=true", async () => {
    const { userId, profileId } = await seedUserAndProfile();
    // Same shape as the catchup=false test but the row asks for backfill.
    // First tick fires once and advances by ONE day, not all 3.
    const task = await seedRecurring(userId, profileId, {
      nextRunAt: new Date("2026-06-01T09:00:00Z"),
      catchupMissed: true,
    });

    const events = await runScheduledTaskTick(
      { runInTx: tx, store, now: () => new Date("2026-06-04T08:00:00Z") },
      stepRun,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.scheduledFor).toBe("2026-06-01T09:00:00.000Z");

    const after = await tx((trx) => store.getScheduledTask(trx, task.id));
    expect(after?.nextRunAt.toISOString()).toBe("2026-06-02T09:00:00.000Z");
  });

  it("one-off rows fire once and flip enabled=false", async () => {
    const { userId, profileId } = await seedUserAndProfile();
    const task = await seedOneOff(userId, profileId, new Date("2026-06-01T09:00:00Z"));

    const events = await runScheduledTaskTick(
      { runInTx: tx, store, now: () => new Date("2026-06-01T09:30:00Z") },
      stepRun,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.taskId).toBe(task.id);

    const after = await tx((trx) => store.getScheduledTask(trx, task.id));
    expect(after?.enabled).toBe(false);
    expect(after?.lastRunAt?.toISOString()).toBe("2026-06-01T09:00:00.000Z");
    // next_run_at is left at the original fire time for audit.
    expect(after?.nextRunAt.toISOString()).toBe("2026-06-01T09:00:00.000Z");

    // A second tick after the row is disabled is a no-op.
    const events2 = await runScheduledTaskTick(
      { runInTx: tx, store, now: () => new Date("2027-01-01T00:00:00Z") },
      stepRun,
    );
    expect(events2).toEqual([]);
  });

  it("skips disabled rows even when their next_run_at is in the past", async () => {
    const { userId, profileId } = await seedUserAndProfile();
    await seedRecurring(userId, profileId, {
      nextRunAt: new Date("2026-01-01T09:00:00Z"),
      enabled: false,
    });

    const events = await runScheduledTaskTick(
      { runInTx: tx, store, now: () => new Date("2026-06-01T09:00:00Z") },
      stepRun,
    );
    expect(events).toEqual([]);
  });

  it("honours the batchSize cap", async () => {
    const { userId, profileId } = await seedUserAndProfile();
    // Three due rows with distinct nextRunAt to keep ordering deterministic.
    await seedRecurring(userId, profileId, { nextRunAt: new Date("2026-01-01T01:00:00Z") });
    await seedRecurring(userId, profileId, {
      cron: "0 2 * * *",
      nextRunAt: new Date("2026-01-01T02:00:00Z"),
    });
    await seedRecurring(userId, profileId, {
      cron: "0 3 * * *",
      nextRunAt: new Date("2026-01-01T03:00:00Z"),
    });

    const events = await runScheduledTaskTick(
      { runInTx: tx, store, now: () => new Date("2026-06-01T09:00:00Z"), batchSize: 2 },
      stepRun,
    );
    expect(events).toHaveLength(2);

    // A second tick (still within "now") picks up the remaining row.
    const events2 = await runScheduledTaskTick(
      { runInTx: tx, store, now: () => new Date("2026-06-01T09:00:00Z"), batchSize: 2 },
      stepRun,
    );
    expect(events2).toHaveLength(1);
  });

  it("event scheduledFor uses the row's stale fire time, not now()", async () => {
    // Regression guard: a future bug that swapped `row.nextRunAt` for
    // `now` in `buildFirePayload` would silently make catch-up handlers
    // think the fire is "on time" — losing the lateness signal the
    // prompt depends on.
    const { userId, profileId } = await seedUserAndProfile();
    const stale = new Date("2026-06-01T09:00:00Z");
    await seedRecurring(userId, profileId, { nextRunAt: stale });

    const now = new Date("2026-06-04T08:00:00Z");
    const events = await runScheduledTaskTick({ runInTx: tx, store, now: () => now }, stepRun);

    expect(events[0]?.scheduledFor).toBe(stale.toISOString());
    expect(events[0]?.scheduledFor).not.toBe(now.toISOString());
  });

  it("throws loudly if the store yields a recurring row with cron=null (defense in depth)", async () => {
    // The DB CHECK rejects this combination at insert time, so it
    // should be unreachable. But if a future change drops the CHECK
    // or a raw-SQL admin bypass somehow creates the invariant
    // violation, the ticker must throw rather than silently advance
    // next_run_at to itself (infinite no-op loop).
    const fakeStore = mock<Pick<AgentStore, "lockDueScheduledTasks" | "advanceScheduledTask">>();
    fakeStore.lockDueScheduledTasks.mockResolvedValue([
      {
        id: "task-malformed",
        userId: "user-1",
        profileId: "profile-1",
        kind: "recurring",
        cron: null, // <-- the invariant violation
        timezone: "UTC",
        prompt: "x",
        nextRunAt: new Date("2026-06-01T09:00:00Z"),
        lastRunAt: null,
        enabled: true,
        catchupMissed: false,
        source: "manual",
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
    ]);

    await expect(
      runScheduledTaskTick(
        {
          runInTx: tx,
          store: fakeStore,
          now: () => new Date("2026-06-01T09:30:00Z"),
        },
        stepRun,
      ),
    ).rejects.toThrow(/kind='recurring' but cron is null/);
    // And NEVER advances the row (the throw fires before advanceScheduledTask).
    expect(fakeStore.advanceScheduledTask).not.toHaveBeenCalled();
  });
});

// --- Inngest function-level tests (replay, idempotency, configuration) ---

describe("createScheduledTaskTicker (Inngest wiring)", () => {
  let sendSpy: ReturnType<typeof spyOnInngestSend>;
  beforeEach(() => {
    sendSpy = spyOnInngestSend(inngest);
    sendSpy.mockResolvedValue({ ids: ["fake"] });
  });
  afterEach(() => {
    sendSpy.mockRestore();
  });

  it("pins the function configuration (cron, retries, concurrency)", () => {
    const fn = createScheduledTaskTicker(
      { runInTx: fakeRunInTx, store: mock<AgentStore>() },
      inngest,
    );
    // `opts` is a public readonly field on InngestFunction.
    expect(fn.opts.id).toBe("scheduled-task-ticker");
    expect(fn.opts.retries).toBe(0);
    expect(fn.opts.concurrency).toEqual({ limit: 1 });
    expect(fn.opts.triggers).toEqual([{ cron: "* * * * *" }]);
  });

  it("emits one event per due row with idempotency key '<taskId>:<scheduledFor>'", async () => {
    // The event id is THE mechanism Inngest uses to dedup the same
    // fire across ticker retries. Regression-guard the format —
    // dropping the id would produce silent double-fires.
    const fakeStore = mock<AgentStore>();
    fakeStore.lockDueScheduledTasks.mockResolvedValue([
      {
        id: "task-A",
        userId: "user-1",
        profileId: "profile-1",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "a",
        nextRunAt: new Date("2026-06-01T08:00:00Z"),
        lastRunAt: null,
        enabled: true,
        catchupMissed: false,
        source: "agent",
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
      {
        id: "task-B",
        userId: "user-1",
        profileId: "profile-1",
        kind: "one_off",
        cron: null,
        timezone: "UTC",
        prompt: "b",
        nextRunAt: new Date("2026-06-01T08:30:00Z"),
        lastRunAt: null,
        enabled: true,
        catchupMissed: false,
        source: "agent",
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
    ]);
    fakeStore.advanceScheduledTask.mockResolvedValue(undefined);

    const fn = createScheduledTaskTicker(
      {
        runInTx: tx,
        store: fakeStore,
        now: () => new Date("2026-06-01T09:00:00Z"),
      },
      inngest,
    );

    await new InngestTestEngine({
      function: fn,
      events: [{ name: "inngest/function.invoked", data: {} } as never],
    }).execute();

    // Two events, each with the deterministic id.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0]?.[0] as {
      payload: Array<{ id: string; data: { taskId: string; scheduledFor: string } }>;
    };
    expect(call.payload).toHaveLength(2);
    for (const event of call.payload) {
      expect(event.id).toBe(`${event.data.taskId}:${event.data.scheduledFor}`);
    }
    // Specific keys, ordered as locked.
    expect(call.payload.map((e) => e.id)).toEqual([
      "task-A:2026-06-01T08:00:00.000Z",
      "task-B:2026-06-01T08:30:00.000Z",
    ]);
  });

  it("does NOT re-run lock-and-advance when Inngest replays with a cached step result", async () => {
    // Crash-recovery invariant: a ticker retry that finds
    // `lock-and-advance` already cached must NOT call
    // lockDueScheduledTasks again — that would double-lock + advance
    // the same rows whose state has already moved on.
    const fakeStore = mock<AgentStore>();
    // If the body runs, the test should see this — but it shouldn't.
    fakeStore.lockDueScheduledTasks.mockResolvedValue([]);

    const fn = createScheduledTaskTicker(
      { runInTx: tx, store: fakeStore, now: () => new Date() },
      inngest,
    );

    // Inject a cached lock-and-advance step that returns one event.
    // The function body must use this cached value, not re-execute.
    const cachedEvents = [
      {
        taskId: "task-cached",
        userId: "user-1",
        profileId: "profile-1",
        scheduledFor: "2026-06-01T09:00:00.000Z",
        prompt: "cached",
      },
    ];
    await new InngestTestEngine({
      function: fn,
      events: [{ name: "inngest/function.invoked", data: {} } as never],
      steps: [{ id: "lock-and-advance", handler: () => cachedEvents }],
    }).execute();

    // The store's lock + advance methods were never touched on the replay.
    expect(fakeStore.lockDueScheduledTasks).not.toHaveBeenCalled();
    expect(fakeStore.advanceScheduledTask).not.toHaveBeenCalled();
    // But the fan-out still went out using the cached events.
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
