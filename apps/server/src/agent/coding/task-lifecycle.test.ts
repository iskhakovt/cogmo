import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { logger } from "../../logger.js";
import { fakeRunInTx, makeStepRun, nullStepSendEvent } from "../../test/factories.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import type { CodingStore } from "./store/index.js";
import { advanceTask } from "./task-lifecycle.js";

type Transition = Awaited<ReturnType<CodingStore["transitionTaskStatus"]>>;

function harness(transition: Transition) {
  const store = mock<CodingStore>();
  store.transitionTaskStatus.mockResolvedValue(transition);
  const run: CodingRun = {
    taskId: "task-1",
    runId: "run-1",
    stepRun: makeStepRun(),
    stepSendEvent: nullStepSendEvent(),
    log: logger,
  };
  const deps: TaskStoreDeps = { runInTx: fakeRunInTx, store };
  return { run, deps };
}

const PUSHED = { stepId: "transition-pushed", from: "verifying", to: "pushed" } as const;

describe("advanceTask", () => {
  it("reads stale at a settled status as advanced", async () => {
    const h = harness({ kind: "stale", status: "pr_open", claimedByRunId: "run-1" });

    const outcome = await advanceTask(h.run, h.deps, { ...PUSHED, settledAt: ["pr_open"] });

    expect(outcome).toEqual({ kind: "advanced" });
  });

  it("reads stale at pr_open as ended where the advance does not settle it", async () => {
    const h = harness({ kind: "stale", status: "pr_open", claimedByRunId: "run-1" });

    const outcome = await advanceTask(h.run, h.deps, PUSHED);

    expect(outcome).toMatchObject({ kind: "left", via: "ended" });
  });

  it("reads stale at a non-terminal status other than the target as moved", async () => {
    const h = harness({ kind: "stale", status: "executing", claimedByRunId: "run-2" });

    const outcome = await advanceTask(h.run, h.deps, PUSHED);

    expect(outcome).toMatchObject({ kind: "left", via: "moved" });
  });

  it("throws on a vanished row — the run's own claim guarantees it exists", async () => {
    const h = harness({ kind: "not_found" });

    await expect(advanceTask(h.run, h.deps, PUSHED)).rejects.toThrow(/vanished/);
  });
});
