import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import { inngest } from "../../inngest/client.js";
import { logger } from "../../logger.js";
import { spyOnInngestSend } from "../../test/factories.js";
import {
  createCodingTaskReconcile,
  matchesCodingOrchestrator,
  reconcileCodingTaskFailure,
} from "./reconcile-on-failure.js";
import type { CodingStore } from "./store/index.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function basePayload(
  overrides?: Partial<{
    functionId: string;
    runId: string;
    taskId: string | undefined;
    errorMessage: string;
  }>,
) {
  return {
    functionId: overrides?.functionId ?? "coding-task-start",
    runId: overrides?.runId ?? "01KRM7A886F293XVTJPVB9CZ91",
    errorMessage: overrides?.errorMessage ?? "connect_worker_stopped_responding",
    taskId:
      overrides && "taskId" in overrides
        ? overrides.taskId
        : "019e2875-2076-7730-b552-3cbbfb9b45d2",
  };
}

describe("reconcileCodingTaskFailure", () => {
  // `reconciled` carries `failureReason` so the durable wrapper
  // (`createCodingTaskReconcile`) can pass it to `step.sendEvent`. The
  // pure function does NOT emit — that's the wrapper's job. See the
  // PR #267 review for the bug trace that motivated this split.
  it("flips non-terminal coding_tasks row to failed and returns the failureReason for the wrapper to emit", async () => {
    const store = mock<CodingStore>();
    store.failTaskIfNonTerminal.mockResolvedValue({ kind: "failed" });

    const result = await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      basePayload({
        taskId: "019e2875-2076-7730-b552-3cbbfb9b45d2",
        errorMessage: "connect_worker_stopped_responding",
      }),
    );

    expect(result).toEqual({
      status: "reconciled",
      taskId: "019e2875-2076-7730-b552-3cbbfb9b45d2",
      failureReason: expect.stringContaining("connect_worker_stopped_responding"),
    });
    expect(store.failTaskIfNonTerminal).toHaveBeenCalledWith(
      expect.anything(),
      "019e2875-2076-7730-b552-3cbbfb9b45d2",
      expect.stringContaining("connect_worker_stopped_responding"),
    );
  });

  // Idempotency vs the in-worker `try/catch` path: when the catch already
  // wrote `failed` (the normal case for any failure the worker could
  // observe), the reconcile arrives second, sees the row already
  // terminal, and the wrapper MUST NOT re-emit `coding/task/failed` —
  // that would double-fire `cleanup-run-branch` etc. We pin this at the
  // result-shape boundary: the pure function returns a `skipped` result
  // on this path, which the wrapper branches on.
  it("returns already_terminal (no reconciled) when the in-worker catch already wrote terminal status", async () => {
    const store = mock<CodingStore>();
    store.failTaskIfNonTerminal.mockResolvedValue({
      kind: "already_terminal",
      status: "failed",
    });

    const result = await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      basePayload({ taskId: "abc-123" }),
    );

    expect(result).toEqual({
      status: "skipped",
      reason: "already_terminal",
      priorStatus: "failed",
    });
  });

  it("skips failures from non-coding-orchestrator functions (defense against bus-wide subscription)", async () => {
    const store = mock<CodingStore>();

    const result = await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      basePayload({ functionId: "handle-message", taskId: "abc-123" }),
    );

    expect(result).toEqual({ status: "skipped", reason: "not_coding_orchestrator" });
    expect(store.failTaskIfNonTerminal).not.toHaveBeenCalled();
  });

  // Inngest deployments may prefix the function id with the app id
  // (`<app>/coding-task-start`). The reconcile's matcher needs to accept
  // both bare and prefixed forms — pin the contract.
  it.each([
    "coding-task-start",
    "coding-task-execute",
    "coding-task-verify",
    "cogmo-coding-task-start",
    "cogmo/coding-task-execute",
  ])("matches coding orchestrator id variant %s", (functionId) => {
    expect(matchesCodingOrchestrator(functionId)).toBe(true);
  });

  it.each([
    "handle-message",
    "recover-conversation",
    "coding-orphan-run-branch-sweep-cron",
    "skill-runner",
    // Suffix collision guard: a function literally named
    // "x-coding-task-start" is intentionally accepted (real app-prefix
    // shape), but a substring without a separator must NOT match.
    "coding-task-start-followup",
  ])("does NOT match non-coding-orchestrator id %s", (functionId) => {
    expect(matchesCodingOrchestrator(functionId)).toBe(false);
  });

  it("skips when the failed run's event payload has no taskId (malformed / unexpected shape)", async () => {
    const store = mock<CodingStore>();
    const warnSpy = vi.spyOn(logger, "warn");

    const result = await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      basePayload({ taskId: undefined }),
    );

    expect(result).toEqual({ status: "skipped", reason: "missing_task_id" });
    expect(store.failTaskIfNonTerminal).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips when the task row no longer exists (e.g. user cancelled and deleted before reconcile fired)", async () => {
    const store = mock<CodingStore>();
    store.failTaskIfNonTerminal.mockResolvedValue({ kind: "not_found" });

    const result = await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      basePayload({ taskId: "gone-123" }),
    );

    expect(result).toEqual({ status: "skipped", reason: "task_not_found" });
  });

  // The failure_reason text is the only telemetry surface a human sees
  // when they look at a reconciled row days later. Pin the shape so
  // future edits don't quietly drop the run_id or function_id.
  it("failure_reason carries the run_id and function_id for forensic traceability", async () => {
    const store = mock<CodingStore>();
    store.failTaskIfNonTerminal.mockResolvedValue({ kind: "failed" });

    const result = await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      basePayload({
        functionId: "coding-task-execute",
        runId: "01XYZ",
        taskId: "abc-123",
        errorMessage: "The worker stopped responding to the request.",
      }),
    );

    // Pin on both the DB write (what gets persisted) and the returned
    // `failureReason` (what the wrapper passes to step.sendEvent). The
    // two MUST be the same string — divergence would mean the
    // post-mortem reason in `coding_tasks.failure_reason` and the
    // event payload disagree.
    expect(store.failTaskIfNonTerminal).toHaveBeenCalledWith(
      expect.anything(),
      "abc-123",
      expect.stringMatching(/run_id 01XYZ/),
    );
    expect(store.failTaskIfNonTerminal).toHaveBeenCalledWith(
      expect.anything(),
      "abc-123",
      expect.stringMatching(/function_id coding-task-execute/),
    );
    expect(store.failTaskIfNonTerminal).toHaveBeenCalledWith(
      expect.anything(),
      "abc-123",
      expect.stringContaining("The worker stopped responding"),
    );
    if (result.status !== "reconciled") throw new Error("expected reconciled");
    expect(result.failureReason).toMatch(/run_id 01XYZ/);
    expect(result.failureReason).toMatch(/function_id coding-task-execute/);
    expect(result.failureReason).toContain("The worker stopped responding");
  });
});

// ─── Wrapper-level: createCodingTaskReconcile ────────────────────────
//
// The durability fix split the work into two `step.*` calls:
//   step 1: `step.run("reconcile", ...)` — caches the DB write result.
//   step 2: `step.sendEvent("emit-failed", ...)` — durable bus emit
//           with `id: "reconcile-${run_id}"` as the idempotency key.
//
// These tests pin the split — that the emit is durable, runs only on
// the reconciled branch, and carries the explicit `id`. The bug they
// guard against: a regression that puts the `inngest.send` back inside
// the cached step would silently lose the event on retry-after-blip,
// because the cached step's retry sees `already_terminal` and skips.
// See PR #267 review for the trace.

function makeFailureEvent(args: { taskId: string; runId: string; functionId: string }) {
  return {
    name: "inngest/function.failed" as const,
    data: {
      function_id: args.functionId,
      run_id: args.runId,
      error: { name: "Error", message: "decoy failure" },
      event: { name: "coding/task/start", data: { taskId: args.taskId } },
    },
  };
}

describe("createCodingTaskReconcile — durable wrapper", () => {
  let sendSpy: ReturnType<typeof spyOnInngestSend>;

  beforeEach(() => {
    sendSpy = spyOnInngestSend(inngest);
    sendSpy.mockResolvedValue({ ids: [] });
  });
  afterEach(() => {
    sendSpy.mockRestore();
  });

  it("on reconciled: invokes step.sendEvent exactly once with idempotency id 'reconcile-' + run_id", async () => {
    const store = mock<CodingStore>();
    const fn = createCodingTaskReconcile(
      { runInTx: ((cb) => cb({ __mockTx: true } as never)) as Transactor, store },
      inngest,
    );
    // Pre-stub the DB step as already-cached with a `reconciled`
    // outcome — that's what a happy first attempt would produce. The
    // emit step is what the test is here to assert.
    const engine = new InngestTestEngine({
      function: fn,
      events: [
        makeFailureEvent({
          taskId: "task-001",
          runId: "run-aaa",
          functionId: "cogmo-coding-task-start",
        }),
      ],
      steps: [
        {
          id: "reconcile",
          handler: () => ({
            status: "reconciled" as const,
            taskId: "task-001",
            failureReason: "decoy reason",
          }),
        },
      ],
    });

    await engine.execute();

    // Inngest's send is called once for the emit-failed step. The
    // payload carries the explicit idempotency `id` so a bus-level
    // retry deduplicates — without it, a transient send blip followed
    // by a retry would double-fire `cleanup-run-branch`.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sendCall = sendSpy.mock.calls[0]?.[0] as unknown;
    expect(sendCall).toMatchObject({
      payload: {
        name: "coding/task/failed",
        id: "reconcile-run-aaa",
        data: { taskId: "task-001", reason: "decoy reason" },
      },
    });
  });

  it.each([
    "already_terminal",
    "not_coding_orchestrator",
    "missing_task_id",
    "task_not_found",
  ])("on skipped (reason=%s): does NOT emit coding/task/failed", async (reason) => {
    const store = mock<CodingStore>();
    const fn = createCodingTaskReconcile(
      { runInTx: ((cb) => cb({ __mockTx: true } as never)) as Transactor, store },
      inngest,
    );
    const cachedResult =
      reason === "already_terminal"
        ? { status: "skipped" as const, reason: "already_terminal" as const, priorStatus: "failed" }
        : { status: "skipped" as const, reason: reason as "not_coding_orchestrator" };
    const engine = new InngestTestEngine({
      function: fn,
      events: [
        makeFailureEvent({
          taskId: "task-skip",
          runId: "run-skip",
          functionId: "cogmo-coding-task-start",
        }),
      ],
      steps: [{ id: "reconcile", handler: () => cachedResult }],
    });

    await engine.execute();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
