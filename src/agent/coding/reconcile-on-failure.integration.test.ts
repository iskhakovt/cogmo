/// <reference path="../../../test/vitest.d.ts" />

/**
 * Integration test for `coding-task-reconcile` against a real Inngest dev
 * server.
 *
 * Unit-tier `reconcile-on-failure.test.ts` exercises the pure handler
 * function with a mock Inngest client. This test goes one layer up: a real
 * Inngest dev server (booted by the integration globalSetup) receives the
 * `inngest/function.failed` system event, the registered reconcile
 * function fires on it, and the row in real Postgres flips to `failed`.
 *
 * What this proves over the unit test:
 *   - The trigger declaration (`triggers: [inngestFunctionFailed]`) is
 *     wired correctly — Inngest actually dispatches on the system event
 *     name.
 *   - The conditional UPDATE works against real Postgres, not just PGlite.
 *   - The downstream `coding/task/failed` event lands on the bus and a
 *     subscriber can pick it up.
 *
 * What this does NOT prove (deliberately):
 *   - That Inngest's `connect_worker_stopped_responding` outcome
 *     actually triggers the system event. That's library behaviour — we
 *     subscribe and trust it. To force the worker-disconnect scenario
 *     we'd need a primitive the harness doesn't have (kill the worker
 *     mid-step). Synthetic emit covers the wiring side; the upstream
 *     guarantee is library territory.
 */

import { eq } from "drizzle-orm";
import { Inngest } from "inngest";
import { connect } from "inngest/connect";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { db, transactor } from "../../db/index.js";
import { codingTaskFailed } from "../../inngest/events.js";
import { createCodingTaskReconcile } from "./reconcile-on-failure.js";
import { DrizzleCodingStore } from "./store/index.js";
import { codingRepos, codingTasks } from "./store/schema.js";

let connection: Awaited<ReturnType<typeof connect>>;
let testInngest: Inngest;
// Captured events carry `id` so tests can pin the idempotency key the
// reconcile wrapper sets via `step.sendEvent({..., id})`. Without this
// projection, a regression that drops the `id` (and quietly relies on
// the bus default of a server-minted UUID) would pass the data-shape
// assertions and only surface in production as duplicate emits on
// retry.
const capturedFailedEvents: Array<{ id: string; taskId: string; reason: string }> = [];
const seededRepoIds: string[] = [];
const seededTaskIds: string[] = [];

beforeAll(async () => {
  // Match the app's client id — the `inngest/function.failed` system event
  // carries `function_id` as `<app-id>-<function-id>` and the reconcile's
  // suffix-matcher accepts that shape, but having the same app id means we
  // can also fire targeted events without ambiguity.
  testInngest = new Inngest({ id: "cogmo-reconcile-itest", isDev: true });

  const reconcileFn = createCodingTaskReconcile(
    { runInTx: transactor(db), store: new DrizzleCodingStore() },
    testInngest,
  );
  const captureFailed = testInngest.createFunction(
    { id: "test-capture-coding-task-failed", triggers: [codingTaskFailed] },
    async ({ event }) => {
      // `event.id` is the bus-level idempotency key — captured so the
      // assertion below can pin `reconcile-${run_id}`.
      capturedFailedEvents.push({ id: event.id ?? "", ...event.data });
      return { captured: true };
    },
  );

  // Decoy functions that share function-ids with the real coding
  // orchestrators (under this test app, so the full function_id is
  // `cogmo-reconcile-itest-coding-task-start` — suffix-matches the
  // reconcile's id matcher). Each listens on `TRIGGER_EVENT` and
  // throws immediately; with `retries: 0` Inngest emits
  // `inngest/function.failed` on the first attempt.
  const makeDecoy = (id: "coding-task-start" | "coding-task-execute") =>
    testInngest.createFunction(
      { id, retries: 0, triggers: [{ event: TRIGGER_EVENT }] },
      async ({ event }) => {
        throw new Error(
          `decoy ${id} failure for taskId=${(event.data as { taskId?: string }).taskId ?? "?"}`,
        );
      },
    );
  const decoyStart = makeDecoy("coding-task-start");
  const decoyExecute = makeDecoy("coding-task-execute");

  // A "non-coding" decoy too — its function_id will be
  // `cogmo-reconcile-itest-non-coding-decoy`, which the reconcile's
  // matcher must NOT match.
  const nonCodingDecoy = testInngest.createFunction(
    {
      id: "non-coding-decoy",
      retries: 0,
      triggers: [{ event: "test/reconcile/non-coding-trigger" }],
    },
    async () => {
      throw new Error("non-coding decoy failure");
    },
  );

  connection = await connect({
    apps: [
      {
        client: testInngest,
        functions: [reconcileFn, captureFailed, decoyStart, decoyExecute, nonCodingDecoy],
      },
    ],
  });
});

afterAll(async () => {
  if (connection) await connection.close();
  // Surgical per-test cleanup — only the rows this file seeded. A broad
  // `DELETE FROM coding_tasks` would step on every other integration
  // test sharing the Postgres instance.
  for (const taskId of seededTaskIds) {
    await db.delete(codingTasks).where(eq(codingTasks.id, taskId));
  }
  for (const repoId of seededRepoIds) {
    await db.delete(codingRepos).where(eq(codingRepos.id, repoId));
  }
});

async function seedRepoAndTask(initialStatus: "planning" | "executing" | "failed") {
  const store = new DrizzleCodingStore();
  const tx = transactor(db);
  const suffix = Math.random().toString(36).slice(2, 8);
  const repo = await tx((trx) =>
    store.insertRepo(trx, {
      name: `reconcile-itest-${suffix}`,
      localPath: `/tmp/reconcile-itest-${suffix}`,
      defaultBranch: "main",
      remoteUrl: `https://github.com/test/reconcile-itest-${suffix}.git`,
      devcontainer: null,
      allowedBackends: ["claude"],
      verifyCommand: "true",
      taskTokenBudget: 100_000,
      taskWallTimeSeconds: 60,
      maxConcurrentTasks: 1,
    }),
  );
  const task = await tx((trx) =>
    store.insertTask(trx, {
      repoId: repo.id,
      goal: "reconcile test",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    }),
  );
  // Insert returns the row in `queued` — bump to the requested status.
  await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: initialStatus }));
  seededRepoIds.push(repo.id);
  seededTaskIds.push(task.id);
  return { taskId: task.id, repoId: repo.id };
}

async function sendInngestEvent(name: string, data: Record<string, unknown>): Promise<void> {
  const baseUrl = inject("inngestBaseUrl");
  const eventKey = inject("inngestEventKey");
  const res = await fetch(`${baseUrl}/e/${eventKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) {
    throw new Error(`failed to send ${name}: ${res.status} ${await res.text()}`);
  }
}

/**
 * Fire-event-for-trigger trigger for the failing decoy functions below.
 * Each decoy listens on this with a `taskId` payload, then immediately
 * throws — Inngest exhausts retries (0) and emits `inngest/function.failed`
 * environment-wide, which the reconcile function (registered under the
 * same app, with the bare `coding-task-*` ids) picks up.
 *
 * We can't directly POST `inngest/function.failed` because Inngest's
 * event API rejects reserved internal names ("event name is reserved for
 * internal use"). The only way to make the real system event fire is to
 * make a real function fail.
 */
const TRIGGER_EVENT = "test/reconcile/trigger";

async function waitForTaskStatus(
  taskId: string,
  status: "failed",
  timeoutMs = 30_000,
): Promise<{ status: string; failureReason: string | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await db
      .select({ status: codingTasks.status, failureReason: codingTasks.failureReason })
      .from(codingTasks)
      .where(eq(codingTasks.id, taskId));
    const row = rows[0];
    if (row && row.status === status) return row;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for task ${taskId} to reach status=${status}`);
}

async function waitForFailedEvent(
  taskId: string,
  timeoutMs = 30_000,
): Promise<{ id: string; taskId: string; reason: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = capturedFailedEvents.find((e) => e.taskId === taskId);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for coding/task/failed for ${taskId}`);
}

describe("coding-task-reconcile — Inngest integration", () => {
  it("flips a non-terminal coding_tasks row to failed and emits coding/task/failed when a coding orchestrator's run fails", async () => {
    const { taskId } = await seedRepoAndTask("planning");

    // Fire the decoy `coding-task-start` — it throws, Inngest emits
    // `inngest/function.failed` with `function_id` =
    // `cogmo-reconcile-itest-coding-task-start` (the test app id +
    // function id). The real reconcile function's suffix-matcher
    // accepts that shape, picks up the event, and flips our row.
    await sendInngestEvent(TRIGGER_EVENT, { taskId });

    const reloaded = await waitForTaskStatus(taskId, "failed");
    expect(reloaded.status).toBe("failed");
    expect(reloaded.failureReason).toMatch(/decoy coding-task-start failure/);
    expect(reloaded.failureReason).toMatch(/run_id [^\s)]+/);
    expect(reloaded.failureReason).toMatch(/function_id [^\s)]*coding-task-start/);

    const failedEvent = await waitForFailedEvent(taskId);
    expect(failedEvent.reason).toMatch(/decoy coding-task-start failure/);
    // Idempotency `id` from `step.sendEvent({..., id: \`reconcile-${run_id}\`})` —
    // pin the prefix so a regression that drops the explicit id (and
    // falls back to a server-minted UUID) fails here. Without the id,
    // a retry of the emit step after a transient send failure would
    // double-fire `cleanup-run-branch`. The run_id is opaque (Inngest
    // mints it per run), so we match on the prefix only.
    expect(failedEvent.id).toMatch(/^reconcile-/);
  });

  // Idempotency contract over the bus: an already-terminal row must not
  // be re-flipped, and `coding/task/failed` must not be re-emitted. The
  // reconcile's conditional UPDATE + the in-worker catch path both
  // reach `failTaskIfNonTerminal` — the second one through this path
  // sees `already_terminal` and short-circuits.
  it("does NOT re-flip or re-emit when the row is already terminal", async () => {
    const { taskId } = await seedRepoAndTask("planning");
    const tx = transactor(db);
    const store = new DrizzleCodingStore();
    // Simulate the in-worker catch path winning the race.
    await tx((trx) =>
      store.updateTaskStatus(trx, {
        id: taskId,
        status: "failed",
        failureReason: "claude exit code 2",
      }),
    );

    const eventsBefore = capturedFailedEvents.filter((e) => e.taskId === taskId).length;
    await sendInngestEvent(TRIGGER_EVENT, { taskId });

    // Give the reconcile a few seconds to fire. Polling for a negative
    // is awkward — we wait a fixed window then assert the row didn't
    // change and no event was captured.
    await new Promise((r) => setTimeout(r, 4_000));

    const rows = await db
      .select({ status: codingTasks.status, failureReason: codingTasks.failureReason })
      .from(codingTasks)
      .where(eq(codingTasks.id, taskId));
    // Original reason preserved — reconcile saw `already_terminal` and
    // didn't stomp on it.
    expect(rows[0]?.failureReason).toBe("claude exit code 2");
    const eventsAfter = capturedFailedEvents.filter((e) => e.taskId === taskId).length;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it("ignores failures from non-coding-orchestrator function ids", async () => {
    const { taskId } = await seedRepoAndTask("planning");

    // Fire the non-coding decoy — its function_id is
    // `cogmo-reconcile-itest-non-coding-decoy`, which the reconcile
    // matcher must reject.
    await sendInngestEvent("test/reconcile/non-coding-trigger", { taskId });

    await new Promise((r) => setTimeout(r, 4_000));
    const rows = await db
      .select({ status: codingTasks.status })
      .from(codingTasks)
      .where(eq(codingTasks.id, taskId));
    // Row unchanged — reconcile filtered the function id out.
    expect(rows[0]?.status).toBe("planning");
  });

  // Per-test row isolation via random repo names + surgical afterAll
  // cleanup (above) keeps reruns idempotent without per-test truncate.
});
