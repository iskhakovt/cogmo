import type { Inngest } from "inngest";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { logger } from "../../logger.js";
import { fakeRunInTx, makeStepRun, makeStepSendEvent } from "../../test/factories.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import type { CodingStore } from "./store/index.js";
import {
  describeTaskFailure,
  failTaskFromCatch,
  maskTaskFailure,
  recordTaskFailed,
} from "./task-failure.js";
import type { TaskFailure } from "./types.js";

const PAT = `ghp_${"c3".repeat(18)}`;
const DETAIL = `fatal: unable to access 'ssh://git:${PAT}@github.com/o/r.git/'\nMY_TOKEN_${PAT}`;
const MASKED =
  "fatal: unable to access 'ssh://REDACTED@github.com/o/r.git/'\nMY_TOKEN_ghp_REDACTED";
const FAILURE: TaskFailure = { reason: "push_failed", detail: DETAIL };
const MASKED_FAILURE: TaskFailure = { reason: "push_failed", detail: MASKED };

function harness() {
  const store = mock<CodingStore>();
  const inngest = mock<Pick<Inngest, "send">>();
  const run: CodingRun = {
    taskId: "task-1",
    runId: "run-1",
    stepRun: makeStepRun(),
    stepSendEvent: makeStepSendEvent(inngest),
    log: logger,
  };
  const deps: TaskStoreDeps = { runInTx: fakeRunInTx, store };
  return { run, deps, inngest, store };
}

const failedEvent = (failure: TaskFailure) =>
  expect.objectContaining({
    name: "coding/task/failed",
    data: { taskId: "task-1", ...failure },
  });

describe("task failure channel", () => {
  it("recordTaskFailed transitions a live task to failed, emits and returns the masked failure", async () => {
    const h = harness();
    h.store.failTaskIfNonTerminal.mockResolvedValue({ kind: "failed" });

    const recorded = await recordTaskFailed(h.run, h.deps, FAILURE, "transition-failed");

    expect(recorded).toEqual({ kind: "recorded", failure: MASKED_FAILURE });
    expect(h.store.failTaskIfNonTerminal).toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      MASKED_FAILURE,
    );
    expect(h.inngest.send).toHaveBeenCalledWith(failedEvent(MASKED_FAILURE));
  });

  it("recordTaskFailed treats a row already at failed as recorded and still emits", async () => {
    // The step re-executing after a lost result, or reconcile got there
    // first; the `task-failed-<taskId>` id absorbs the repeat emit.
    const h = harness();
    h.store.failTaskIfNonTerminal.mockResolvedValue({ kind: "already_terminal", status: "failed" });

    const recorded = await recordTaskFailed(h.run, h.deps, FAILURE, "transition-failed");

    expect(recorded).toEqual({ kind: "recorded", failure: MASKED_FAILURE });
    expect(h.inngest.send).toHaveBeenCalledWith(failedEvent(MASKED_FAILURE));
  });

  it("recordTaskFailed leaves a cancelled task alone: no write, no emit, reports ended", async () => {
    const h = harness();
    h.store.failTaskIfNonTerminal.mockResolvedValue({
      kind: "already_terminal",
      status: "cancelled",
    });

    const recorded = await recordTaskFailed(h.run, h.deps, FAILURE, "transition-failed");

    expect(recorded).toEqual({ kind: "ended", status: "cancelled" });
    expect(h.inngest.send).not.toHaveBeenCalled();
  });

  it("recordTaskFailed throws on a vanished row — the run's own claim guarantees it exists", async () => {
    const h = harness();
    h.store.failTaskIfNonTerminal.mockResolvedValue({ kind: "not_found" });

    await expect(recordTaskFailed(h.run, h.deps, FAILURE, "transition-failed")).rejects.toThrow(
      /vanished/,
    );
    expect(h.inngest.send).not.toHaveBeenCalled();
  });

  it("failTaskFromCatch records the thrown error as unexpected_error, masked, and emits", async () => {
    const h = harness();
    h.store.failTaskIfNonTerminal.mockResolvedValue({ kind: "failed" });
    const expected: TaskFailure = { reason: "unexpected_error", detail: MASKED };

    const recorded = await failTaskFromCatch(h.run, h.deps, new Error(DETAIL));

    expect(recorded).toEqual({ kind: "recorded", failure: expected });
    expect(h.store.failTaskIfNonTerminal).toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      expected,
    );
    expect(h.inngest.send).toHaveBeenCalledWith(failedEvent(expected));
  });

  it("failTaskFromCatch describes a non-Error throw too", async () => {
    const h = harness();
    h.store.failTaskIfNonTerminal.mockResolvedValue({ kind: "failed" });

    const recorded = await failTaskFromCatch(h.run, h.deps, "boom");

    expect(recorded).toEqual({
      kind: "recorded",
      failure: { reason: "unexpected_error", detail: "boom" },
    });
  });

  it.each(["pr_open", "failed", "cancelled"] as const)(
    "failTaskFromCatch keeps a task already at %s: no failure recorded, nothing emitted",
    async (status) => {
      const h = harness();
      h.store.failTaskIfNonTerminal.mockResolvedValue({ kind: "already_terminal", status });

      const recorded = await failTaskFromCatch(h.run, h.deps, new Error("late throw"));

      expect(recorded).toEqual({ kind: "ended", status });
      expect(h.inngest.send).not.toHaveBeenCalled();
    },
  );

  it("failTaskFromCatch throws on a vanished row", async () => {
    const h = harness();
    h.store.failTaskIfNonTerminal.mockResolvedValue({ kind: "not_found" });

    await expect(failTaskFromCatch(h.run, h.deps, new Error("x"))).rejects.toThrow(/vanished/);
    expect(h.inngest.send).not.toHaveBeenCalled();
  });

  it("maskTaskFailure masks the detail and keeps the reason", () => {
    expect(maskTaskFailure(FAILURE)).toEqual(MASKED_FAILURE);
  });

  it("describeTaskFailure labels the reason and appends the detail when there is one", () => {
    expect(describeTaskFailure({ reason: "verify_failed", detail: "exit 1\n\nFAIL" })).toBe(
      "Verify failed: exit 1\n\nFAIL",
    );
    expect(describeTaskFailure({ reason: "user_cancelled", detail: "" })).toBe(
      "Cancelled by the user",
    );
  });
});
