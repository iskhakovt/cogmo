import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleAgentStore } from "../store/index.js";
import {
  createSchedulingService,
  DEFAULT_SCHEDULED_TASK_CAP,
  type SchedulingService,
} from "./scheduling-service.js";

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

async function seed(): Promise<{ userId: string; profileId: string; service: SchedulingService }> {
  const userId = (await tx((trx) => store.createUser(trx))).id;
  const profileId = (
    await tx((trx) =>
      store.createProfile(trx, {
        userId,
        name: "test",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      }),
    )
  ).id;
  const service = createSchedulingService({
    runInTx: tx,
    agentStore: store,
    userId,
    profileId,
    defaultTimezone: "UTC",
  });
  return { userId, profileId, service };
}

describe("SchedulingService.create — recurring", () => {
  it("validates, computes nextRunAt, persists, returns id + nextRunAt", async () => {
    const { service } = await seed();
    const result = await service.create({
      kind: "recurring",
      cron: "0 9 * * *",
      prompt: "morning briefing",
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error("unreachable");
    expect(result.value.id).toBeDefined();
    // 09:00 UTC tomorrow at the earliest — `nextRunAt` is strictly in the future.
    expect(result.value.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns structured validation error on bad cron (no DB write)", async () => {
    const { userId, service } = await seed();
    const result = await service.create({
      kind: "recurring",
      cron: "99 * * * *",
      prompt: "x",
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error).toMatchObject({ kind: "validation", cause: { kind: "malformed" } });

    // No row was persisted — the validation gate ran before the DB write.
    const list = await tx((trx) => store.listScheduledTasks(trx, userId));
    expect(list).toEqual([]);
  });

  it("returns structured validation error on bad timezone", async () => {
    const { service } = await seed();
    const result = await service.create({
      kind: "recurring",
      cron: "0 9 * * *",
      timezone: "Atlantis/Capital",
      prompt: "x",
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error).toMatchObject({
      kind: "validation",
      cause: { kind: "invalid_timezone", timezone: "Atlantis/Capital" },
    });
  });

  it("defaults timezone to the service's defaultTimezone when omitted", async () => {
    const { userId, service } = await seed();
    await service.create({ kind: "recurring", cron: "0 9 * * *", prompt: "x" });
    const rows = await tx((trx) => store.listScheduledTasks(trx, userId));
    expect(rows[0]?.timezone).toBe("UTC");
  });

  it("honours an explicit timezone over the default", async () => {
    const { userId, service } = await seed();
    await service.create({
      kind: "recurring",
      cron: "0 9 * * *",
      timezone: "Europe/London",
      prompt: "x",
    });
    const rows = await tx((trx) => store.listScheduledTasks(trx, userId));
    expect(rows[0]?.timezone).toBe("Europe/London");
  });

  it("defaults catchupMissed to false", async () => {
    const { userId, service } = await seed();
    await service.create({ kind: "recurring", cron: "0 9 * * *", prompt: "x" });
    const rows = await tx((trx) => store.listScheduledTasks(trx, userId));
    expect(rows[0]?.catchupMissed).toBe(false);
  });

  it("honours catchupMissed=true", async () => {
    const { userId, service } = await seed();
    await service.create({
      kind: "recurring",
      cron: "0 9 * * *",
      catchupMissed: true,
      prompt: "x",
    });
    const rows = await tx((trx) => store.listScheduledTasks(trx, userId));
    expect(rows[0]?.catchupMissed).toBe(true);
  });
});

describe("SchedulingService.create — one_off", () => {
  it("persists an ISO-8601-with-Z runAt", async () => {
    const { userId, service } = await seed();
    // Pick a future instant. Must be in the future per the runAt guard.
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = await service.create({
      kind: "one_off",
      runAt: future,
      prompt: "remind",
    });
    expect(result.isOk()).toBe(true);
    const rows = await tx((trx) => store.listScheduledTasks(trx, userId));
    expect(rows[0]?.kind).toBe("one_off");
    expect(rows[0]?.cron).toBeNull();
    expect(rows[0]?.nextRunAt.toISOString()).toBe(future);
  });

  it("rejects ISO without timezone marker (ambiguous)", async () => {
    const { service } = await seed();
    const result = await service.create({
      kind: "one_off",
      runAt: "2099-06-01T15:00:00",
      prompt: "x",
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error).toMatchObject({
      kind: "invalid_run_at",
      runAt: "2099-06-01T15:00:00",
    });
  });

  it("rejects a runAt in the past", async () => {
    const { service } = await seed();
    const result = await service.create({
      kind: "one_off",
      runAt: "2020-01-01T00:00:00Z",
      prompt: "x",
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid_run_at");
  });

  it("rejects an unparseable runAt", async () => {
    const { service } = await seed();
    const result = await service.create({
      kind: "one_off",
      runAt: "nope-not-a-date-Z",
      prompt: "x",
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid_run_at");
  });

  it("forces catchupMissed=false for one-offs (recurring-only flag)", async () => {
    const { userId, service } = await seed();
    await service.create({
      kind: "one_off",
      runAt: new Date(Date.now() + 60_000).toISOString(),
      prompt: "x",
    });
    const rows = await tx((trx) => store.listScheduledTasks(trx, userId));
    expect(rows[0]?.catchupMissed).toBe(false);
  });
});

describe("SchedulingService.create — cap enforcement", () => {
  it("rejects when the user is at the cap", async () => {
    const { userId, profileId } = await seed();
    // Use a small cap to keep the test fast.
    const service = createSchedulingService({
      runInTx: tx,
      agentStore: store,
      userId,
      profileId,
      defaultTimezone: "UTC",
      taskCap: 2,
    });

    expect(
      (await service.create({ kind: "recurring", cron: "0 9 * * *", prompt: "a" })).isOk(),
    ).toBe(true);
    expect(
      (await service.create({ kind: "recurring", cron: "0 10 * * *", prompt: "b" })).isOk(),
    ).toBe(true);

    const result = await service.create({ kind: "recurring", cron: "0 11 * * *", prompt: "c" });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error).toEqual({ kind: "task_cap_exceeded", limit: 2, current: 2 });

    // Confirm the cap is enforced — only 2 rows in the DB.
    const rows = await tx((trx) => store.listScheduledTasks(trx, userId));
    expect(rows).toHaveLength(2);
  });

  it("counts disabled rows toward the cap (no graveyard bypass)", async () => {
    const { userId, profileId } = await seed();
    const service = createSchedulingService({
      runInTx: tx,
      agentStore: store,
      userId,
      profileId,
      defaultTimezone: "UTC",
      taskCap: 1,
    });
    const first = await service.create({ kind: "recurring", cron: "0 9 * * *", prompt: "a" });
    expect(first.isOk()).toBe(true);
    if (first.isErr()) throw new Error("unreachable");
    // Disable the first row.
    await tx((trx) => store.setScheduledTaskEnabled(trx, first.value.id, false));
    // Try to add another — should still hit the cap, even though the first is disabled.
    const second = await service.create({ kind: "recurring", cron: "0 10 * * *", prompt: "b" });
    expect(second.isErr()).toBe(true);
  });

  it("default cap exposed as constant", () => {
    expect(DEFAULT_SCHEDULED_TASK_CAP).toBe(200);
  });
});

describe("SchedulingService.list", () => {
  it("returns user's own tasks newest-first", async () => {
    const { service } = await seed();
    // Seed two tasks via the service so summaries match exactly.
    const a = await service.create({ kind: "recurring", cron: "0 9 * * *", prompt: "a" });
    const b = await service.create({ kind: "recurring", cron: "0 10 * * *", prompt: "b" });
    if (a.isErr() || b.isErr()) throw new Error("setup failed");

    const list = await service.list();
    expect(list).toHaveLength(2);
    // Newest-first per the underlying store contract.
    expect(list[0]?.id).toBe(b.value.id);
    expect(list[1]?.id).toBe(a.value.id);
    expect(list[0]?.prompt).toBe("b");
    expect(list[0]?.timezone).toBe("UTC");
    expect(list[0]?.enabled).toBe(true);
    // `ScheduledTaskSummary` deliberately omits `userId` at the type
    // level — the absence is enforced by TS, no runtime assertion needed.
  });

  it("does NOT include other users' tasks", async () => {
    const a = await seed();
    const b = await seed();
    await a.service.create({ kind: "recurring", cron: "0 9 * * *", prompt: "a-prompt" });
    await b.service.create({ kind: "recurring", cron: "0 9 * * *", prompt: "b-prompt" });

    const aList = await a.service.list();
    const bList = await b.service.list();
    expect(aList).toHaveLength(1);
    expect(bList).toHaveLength(1);
    expect(aList[0]?.prompt).toBe("a-prompt");
    expect(bList[0]?.prompt).toBe("b-prompt");
  });

  it("returns an empty array when the user has no tasks", async () => {
    const { service } = await seed();
    expect(await service.list()).toEqual([]);
  });
});

describe("SchedulingService.remove", () => {
  it("deletes a task the user owns", async () => {
    const { service } = await seed();
    const create = await service.create({ kind: "recurring", cron: "0 9 * * *", prompt: "x" });
    if (create.isErr()) throw new Error("setup failed");

    const result = await service.remove(create.value.id);
    expect(result.isOk()).toBe(true);

    const list = await service.list();
    expect(list).toEqual([]);
  });

  it("returns not_found for an unknown id", async () => {
    const { service } = await seed();
    const result = await service.remove("00000000-0000-7000-8000-000000000000");
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error).toEqual({
      kind: "not_found",
      id: "00000000-0000-7000-8000-000000000000",
    });
  });

  it("refuses to delete another user's task (returns not_found, not unauthorized)", async () => {
    const a = await seed();
    const b = await seed();
    const create = await a.service.create({ kind: "recurring", cron: "0 9 * * *", prompt: "x" });
    if (create.isErr()) throw new Error("setup failed");

    // User B tries to delete user A's task.
    const result = await b.service.remove(create.value.id);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    // Surface "not_found" rather than "unauthorized" — don't leak the
    // existence of other users' tasks to a probing client.
    expect(result.error.kind).toBe("not_found");

    // Sanity: the row still exists for user A.
    expect(await a.service.list()).toHaveLength(1);
  });
});
