import type { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import { matchesCodingOrchestrator, reconcileCodingTaskFailure } from "./reconcile-on-failure.js";
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

function fakeInngest(): Pick<Inngest, "send"> {
  return mock<Pick<Inngest, "send">>();
}

describe("reconcileCodingTaskFailure", () => {
  it("flips non-terminal coding_tasks row to failed and emits coding/task/failed", async () => {
    const store = mock<CodingStore>();
    store.failTaskIfNonTerminal.mockResolvedValue({ kind: "failed" });
    const inngest = fakeInngest();

    const result = await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      inngest,
      basePayload({
        taskId: "019e2875-2076-7730-b552-3cbbfb9b45d2",
        errorMessage: "connect_worker_stopped_responding",
      }),
    );

    expect(result).toEqual({
      status: "reconciled",
      taskId: "019e2875-2076-7730-b552-3cbbfb9b45d2",
    });
    expect(store.failTaskIfNonTerminal).toHaveBeenCalledWith(
      expect.anything(),
      "019e2875-2076-7730-b552-3cbbfb9b45d2",
      expect.stringContaining("connect_worker_stopped_responding"),
    );
    expect(inngest.send).toHaveBeenCalledTimes(1);
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "coding/task/failed",
        data: expect.objectContaining({
          taskId: "019e2875-2076-7730-b552-3cbbfb9b45d2",
        }),
      }),
    );
  });

  // Idempotency vs the in-worker `try/catch` path: when the catch already
  // wrote `failed` (the normal case for any failure the worker could
  // observe), the reconcile arrives second, sees the row already
  // terminal, and MUST NOT re-emit `coding/task/failed` — that would
  // double-fire `cleanup-run-branch` etc.
  it("no-ops + does NOT emit coding/task/failed when the in-worker catch already wrote terminal status", async () => {
    const store = mock<CodingStore>();
    store.failTaskIfNonTerminal.mockResolvedValue({
      kind: "already_terminal",
      status: "failed",
    });
    const inngest = fakeInngest();

    const result = await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      inngest,
      basePayload({ taskId: "abc-123" }),
    );

    expect(result).toEqual({
      status: "skipped",
      reason: "already_terminal",
      priorStatus: "failed",
    });
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("skips failures from non-coding-orchestrator functions (defense against bus-wide subscription)", async () => {
    const store = mock<CodingStore>();
    const inngest = fakeInngest();

    const result = await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      inngest,
      basePayload({ functionId: "handle-message", taskId: "abc-123" }),
    );

    expect(result).toEqual({ status: "skipped", reason: "not_coding_orchestrator" });
    expect(store.failTaskIfNonTerminal).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
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
    const inngest = fakeInngest();
    const warnSpy = vi.spyOn(logger, "warn");

    const result = await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      inngest,
      basePayload({ taskId: undefined }),
    );

    expect(result).toEqual({ status: "skipped", reason: "missing_task_id" });
    expect(store.failTaskIfNonTerminal).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips when the task row no longer exists (e.g. user cancelled and deleted before reconcile fired)", async () => {
    const store = mock<CodingStore>();
    store.failTaskIfNonTerminal.mockResolvedValue({ kind: "not_found" });
    const inngest = fakeInngest();

    const result = await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      inngest,
      basePayload({ taskId: "gone-123" }),
    );

    expect(result).toEqual({ status: "skipped", reason: "task_not_found" });
    expect(inngest.send).not.toHaveBeenCalled();
  });

  // The failure_reason text is the only telemetry surface a human sees
  // when they look at a reconciled row days later. Pin the shape so
  // future edits don't quietly drop the run_id or function_id.
  it("failure_reason carries the run_id and function_id for forensic traceability", async () => {
    const store = mock<CodingStore>();
    store.failTaskIfNonTerminal.mockResolvedValue({ kind: "failed" });
    const inngest = fakeInngest();

    await reconcileCodingTaskFailure(
      { runInTx: fakeRunInTx, store },
      inngest,
      basePayload({
        functionId: "coding-task-execute",
        runId: "01XYZ",
        taskId: "abc-123",
        errorMessage: "The worker stopped responding to the request.",
      }),
    );

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
  });
});
