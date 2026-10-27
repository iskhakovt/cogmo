import type { Inngest } from "inngest";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { logger } from "../../logger.js";
import { fakeRunInTx, makeStepRun, makeStepSendEvent } from "../../test/factories.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import type { CodingStore } from "./store/index.js";
import { failTaskFromCatch, recordTaskFailed } from "./task-failure.js";

const PAT = `ghp_${"c3".repeat(18)}`;
const REASON = `execute push failed (failed):\n\nfatal: unable to access 'ssh://git:${PAT}@github.com/o/r.git/'\nMY_TOKEN_${PAT}`;
const MASKED =
  "execute push failed (failed):\n\nfatal: unable to access 'ssh://REDACTED@github.com/o/r.git/'\nMY_TOKEN_ghp_REDACTED";

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

const FAILED_EVENT = expect.objectContaining({
  name: "coding/task/failed",
  data: { taskId: "task-1", reason: MASKED },
});

describe("task failure channel", () => {
  it("recordTaskFailed transitions a live task to failed, emits and returns the masked reason", async () => {
    const h = harness();
    h.store.failTaskIfNonTerminal.mockResolvedValue({ kind: "failed" });

    const recorded = await recordTaskFailed(h.run, h.deps, REASON, "transition-failed");

    expect(recorded).toEqual({ kind: "recorded", reason: MASKED });
    expect(h.store.failTaskIfNonTerminal).toHaveBeenCalledWith(expect.anything(), "task-1", MASKED);
    expect(h.inngest.send).toHaveBeenCalledWith(FAILED_EVENT);
  });

  it("recordTaskFailed treats a row already at failed as recorded and still emits", async () => {
    // The step re-executing after a lost result, or reconcile got there
    // first; the `task-failed-<taskId>` id absorbs the repeat emit.
    const h = harness();
    h.store.failTaskIfNonTerminal.mockResolvedValue({ kind: "already_terminal", status: "failed" });

    const recorded = await recordTaskFailed(h.run, h.deps, REASON, "transition-failed");

    expect(recorded).toEqual({ kind: "recorded", reason: MASKED });
    expect(h.inngest.send).toHaveBeenCalledWith(FAILED_EVENT);
  });

  it("recordTaskFailed leaves a cancelled task alone: no write, no emit, reports ended", async () => {
    const h = harness();
    h.store.failTaskIfNonTerminal.mockResolvedValue({
      kind: "already_terminal",
      status: "cancelled",
    });

    const recorded = await recordTaskFailed(h.run, h.deps, REASON, "transition-failed");

    expect(recorded).toEqual({ kind: "ended", status: "cancelled" });
    expect(h.store.updateTaskStatus).not.toHaveBeenCalled();
    expect(h.inngest.send).not.toHaveBeenCalled();
  });

  it("recordTaskFailed throws on a vanished row — the run's own claim guarantees it exists", async () => {
    const h = harness();
    h.store.failTaskIfNonTerminal.mockResolvedValue({ kind: "not_found" });

    await expect(recordTaskFailed(h.run, h.deps, REASON, "transition-failed")).rejects.toThrow(
      /vanished/,
    );
    expect(h.inngest.send).not.toHaveBeenCalled();
  });

  it("failTaskFromCatch persists, emits and returns the masked reason", async () => {
    const h = harness();

    const recorded = await failTaskFromCatch(h.run, h.deps, REASON);

    expect(recorded).toBe(MASKED);
    expect(h.store.updateTaskStatus).toHaveBeenCalledWith(expect.anything(), {
      id: "task-1",
      status: "failed",
      failureReason: MASKED,
    });
    expect(h.inngest.send).toHaveBeenCalledWith(FAILED_EVENT);
  });
});
