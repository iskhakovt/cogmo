import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleAgentStore, type ScheduledTask } from "./index.js";

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

async function seed(): Promise<{ userId: string; profileId: string }> {
  const userId = (await tx((trx) => store.createUser(trx))).id;
  // Profile is user-scoped so two seed() calls in the same test don't
  // collide on uq_profiles_user_name (nullsNotDistinct = true would
  // reject two org profiles named "test").
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

function recurringParams(
  userId: string,
  profileId: string,
  overrides: Partial<{ nextRunAt: Date; enabled: boolean; cron: string }> = {},
) {
  return {
    userId,
    profileId,
    kind: "recurring" as const,
    cron: overrides.cron ?? "0 9 * * *",
    timezone: "Europe/London",
    prompt: "morning briefing",
    nextRunAt: overrides.nextRunAt ?? new Date("2026-06-01T08:00:00Z"),
    enabled: overrides.enabled ?? true,
    catchupMissed: false,
    source: "wizard" as const,
  };
}

// Drizzle wraps the inner DB error in "Failed query: ..." and stashes the
// underlying PG/PGlite error on `cause`. Concatenate the chain so we can
// assert against the constraint name from PGlite without depending on
// Drizzle's wrapping format.
function flattenErrorChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  while (cur instanceof Error) {
    parts.push(cur.message);
    cur = cur.cause;
  }
  return parts.join(" | ");
}

describe("DrizzleAgentStore — scheduled_tasks", () => {
  it("creates a recurring task and round-trips every column", async () => {
    const { userId, profileId } = await seed();
    const created = await tx((trx) =>
      store.createScheduledTask(trx, recurringParams(userId, profileId)),
    );

    expect(created).toMatchObject({
      userId,
      profileId,
      kind: "recurring",
      cron: "0 9 * * *",
      timezone: "Europe/London",
      prompt: "morning briefing",
      enabled: true,
      catchupMissed: false,
      source: "wizard",
      lastRunAt: null,
    });
    expect(created.id).toBeDefined();
    expect(created.nextRunAt.toISOString()).toBe("2026-06-01T08:00:00.000Z");

    const fetched = await tx((trx) => store.getScheduledTask(trx, created.id));
    expect(fetched).toEqual(created);
  });

  it("creates a one-off task with null cron", async () => {
    const { userId, profileId } = await seed();
    const created = await tx((trx) =>
      store.createScheduledTask(trx, {
        userId,
        profileId,
        kind: "one_off",
        cron: null,
        timezone: "UTC",
        prompt: "remind me",
        nextRunAt: new Date("2026-07-04T12:00:00Z"),
        enabled: true,
        catchupMissed: false,
        source: "agent",
      }),
    );
    expect(created.kind).toBe("one_off");
    expect(created.cron).toBeNull();
  });

  it("rejects recurring rows without a cron at the DB layer", async () => {
    const { userId, profileId } = await seed();
    const err = await tx((trx) =>
      store.createScheduledTask(trx, {
        ...recurringParams(userId, profileId),
        cron: null,
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(flattenErrorChain(err)).toMatch(/chk_scheduled_tasks_cron/);
  });

  it("rejects one-off rows with a cron at the DB layer", async () => {
    const { userId, profileId } = await seed();
    const err = await tx((trx) =>
      store.createScheduledTask(trx, {
        userId,
        profileId,
        kind: "one_off",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "x",
        nextRunAt: new Date(),
        enabled: true,
        catchupMissed: false,
        source: "manual",
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(flattenErrorChain(err)).toMatch(/chk_scheduled_tasks_cron/);
  });

  it("returns undefined for an unknown id", async () => {
    expect(
      await tx((trx) => store.getScheduledTask(trx, "00000000-0000-7000-8000-000000000000")),
    ).toBeUndefined();
  });

  it("lists tasks for a user newest-first and excludes other users", async () => {
    const a = await seed();
    const b = await seed();
    const t1 = await tx((trx) =>
      store.createScheduledTask(trx, recurringParams(a.userId, a.profileId, { cron: "0 9 * * *" })),
    );
    const t2 = await tx((trx) =>
      store.createScheduledTask(
        trx,
        recurringParams(a.userId, a.profileId, { cron: "0 10 * * *" }),
      ),
    );
    await tx((trx) => store.createScheduledTask(trx, recurringParams(b.userId, b.profileId)));

    const rows = await tx((trx) => store.listScheduledTasks(trx, a.userId));
    expect(rows.map((r: ScheduledTask) => r.id)).toEqual([t2.id, t1.id]);
  });

  it("includeDisabled=false hides disabled rows", async () => {
    const { userId, profileId } = await seed();
    const enabled = await tx((trx) =>
      store.createScheduledTask(trx, recurringParams(userId, profileId, { cron: "0 9 * * *" })),
    );
    const disabled = await tx((trx) =>
      store.createScheduledTask(
        trx,
        recurringParams(userId, profileId, { cron: "0 10 * * *", enabled: false }),
      ),
    );

    const all = await tx((trx) => store.listScheduledTasks(trx, userId));
    expect(all.map((r) => r.id).sort()).toEqual([enabled.id, disabled.id].sort());

    const onlyEnabled = await tx((trx) =>
      store.listScheduledTasks(trx, userId, { includeDisabled: false }),
    );
    expect(onlyEnabled.map((r) => r.id)).toEqual([enabled.id]);
  });

  it("lockDueScheduledTasks returns only enabled, due rows in next_run_at order, respecting limit", async () => {
    const { userId, profileId } = await seed();
    const past1 = await tx((trx) =>
      store.createScheduledTask(
        trx,
        recurringParams(userId, profileId, { nextRunAt: new Date("2026-01-01T00:00:00Z") }),
      ),
    );
    const past2 = await tx((trx) =>
      store.createScheduledTask(
        trx,
        recurringParams(userId, profileId, { nextRunAt: new Date("2026-02-01T00:00:00Z") }),
      ),
    );
    const future = await tx((trx) =>
      store.createScheduledTask(
        trx,
        recurringParams(userId, profileId, { nextRunAt: new Date("2099-01-01T00:00:00Z") }),
      ),
    );
    const disabledPast = await tx((trx) =>
      store.createScheduledTask(
        trx,
        recurringParams(userId, profileId, {
          nextRunAt: new Date("2026-01-01T00:00:00Z"),
          enabled: false,
        }),
      ),
    );

    const due = await tx((trx) =>
      store.lockDueScheduledTasks(trx, { now: new Date("2026-03-01T00:00:00Z"), limit: 10 }),
    );
    expect(due.map((r) => r.id)).toEqual([past1.id, past2.id]);
    expect(due.some((r) => r.id === future.id)).toBe(false);
    expect(due.some((r) => r.id === disabledPast.id)).toBe(false);

    const limited = await tx((trx) =>
      store.lockDueScheduledTasks(trx, { now: new Date("2026-03-01T00:00:00Z"), limit: 1 }),
    );
    expect(limited.map((r) => r.id)).toEqual([past1.id]);
  });

  it("advanceScheduledTask updates timestamps and optionally disables", async () => {
    const { userId, profileId } = await seed();
    const created = await tx((trx) =>
      store.createScheduledTask(trx, recurringParams(userId, profileId)),
    );
    const lastRunAt = new Date("2026-06-01T08:00:00Z");
    const nextRunAt = new Date("2026-06-02T08:00:00Z");

    await tx((trx) => store.advanceScheduledTask(trx, created.id, { lastRunAt, nextRunAt }));
    const advanced = await tx((trx) => store.getScheduledTask(trx, created.id));
    expect(advanced?.lastRunAt?.toISOString()).toBe(lastRunAt.toISOString());
    expect(advanced?.nextRunAt.toISOString()).toBe(nextRunAt.toISOString());
    expect(advanced?.enabled).toBe(true);

    await tx((trx) =>
      store.advanceScheduledTask(trx, created.id, {
        lastRunAt: nextRunAt,
        nextRunAt,
        disable: true,
      }),
    );
    const disabled = await tx((trx) => store.getScheduledTask(trx, created.id));
    expect(disabled?.enabled).toBe(false);
  });

  it("setScheduledTaskEnabled flips the flag and is idempotent", async () => {
    const { userId, profileId } = await seed();
    const created = await tx((trx) =>
      store.createScheduledTask(trx, recurringParams(userId, profileId)),
    );

    await tx((trx) => store.setScheduledTaskEnabled(trx, created.id, false));
    expect((await tx((trx) => store.getScheduledTask(trx, created.id)))?.enabled).toBe(false);

    await tx((trx) => store.setScheduledTaskEnabled(trx, created.id, false));
    expect((await tx((trx) => store.getScheduledTask(trx, created.id)))?.enabled).toBe(false);

    await tx((trx) => store.setScheduledTaskEnabled(trx, created.id, true));
    expect((await tx((trx) => store.getScheduledTask(trx, created.id)))?.enabled).toBe(true);
  });

  it("setScheduledTaskEnabled on an unknown id is a no-op (no throw)", async () => {
    await expect(
      tx((trx) =>
        store.setScheduledTaskEnabled(trx, "00000000-0000-7000-8000-000000000000", false),
      ),
    ).resolves.toBeUndefined();
  });

  it("advanceScheduledTask on an unknown id is a no-op (no throw)", async () => {
    // Contract: the ticker may pick a row, then concurrent psql /
    // admin code deletes it before advance commits. Advance must
    // silently no-op rather than throw, so a row-deletion race
    // doesn't poison the whole ticker batch.
    await expect(
      tx((trx) =>
        store.advanceScheduledTask(trx, "00000000-0000-7000-8000-000000000000", {
          lastRunAt: new Date(),
          nextRunAt: new Date(),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("createScheduledTask rejects an unknown profile_id via FK", async () => {
    const { userId } = await seed();
    const err = await tx((trx) =>
      store.createScheduledTask(trx, {
        userId,
        profileId: "00000000-0000-7000-8000-000000000000",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "x",
        nextRunAt: new Date(),
        enabled: true,
        catchupMissed: false,
        source: "agent",
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(flattenErrorChain(err)).toMatch(/scheduled_tasks_profile_id_profiles_id_fk/);
  });

  it("createScheduledTask rejects an unknown user_id via FK", async () => {
    const { profileId } = await seed();
    const err = await tx((trx) =>
      store.createScheduledTask(trx, {
        userId: "00000000-0000-7000-8000-000000000000",
        profileId,
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "x",
        nextRunAt: new Date(),
        enabled: true,
        catchupMissed: false,
        source: "agent",
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(flattenErrorChain(err)).toMatch(/scheduled_tasks_user_id_users_id_fk/);
  });

  it("deleteScheduledTask removes the row and is idempotent", async () => {
    const { userId, profileId } = await seed();
    const created = await tx((trx) =>
      store.createScheduledTask(trx, recurringParams(userId, profileId)),
    );

    await tx((trx) => store.deleteScheduledTask(trx, created.id));
    expect(await tx((trx) => store.getScheduledTask(trx, created.id))).toBeUndefined();

    await expect(tx((trx) => store.deleteScheduledTask(trx, created.id))).resolves.toBeUndefined();
  });
});
