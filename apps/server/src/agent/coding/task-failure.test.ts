import type { Inngest } from "inngest";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { logger } from "../../logger.js";
import { fakeRunInTx, makeStepRun, makeStepSendEvent } from "../../test/factories.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import type { CodingStore } from "./store/index.js";
import { failTaskFromCatch, recordTaskFailed } from "./task-failure.js";

const PAT = `ghp_${"c3".repeat(18)}`;
const REASON = `execute push failed (failed):\n\nfatal: unable to access 'https://x-access-token:${PAT}@github.com/o/r.git/'`;
const REDACTED =
  "execute push failed (failed):\n\nfatal: unable to access 'https://***:***@github.com/o/r.git/'";

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

describe("task failure channel", () => {
  it("recordTaskFailed persists and emits the reason with credentials redacted", async () => {
    const { run, deps, inngest, store } = harness();

    await recordTaskFailed(run, deps, REASON, "set-status-failed");

    expect(store.updateTaskStatus).toHaveBeenCalledWith(expect.anything(), {
      id: "task-1",
      status: "failed",
      failureReason: REDACTED,
    });
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "coding/task/failed",
        data: { taskId: "task-1", reason: REDACTED },
      }),
    );
  });

  it("failTaskFromCatch persists and emits the reason with credentials redacted", async () => {
    const { run, deps, inngest, store } = harness();

    await failTaskFromCatch(run, deps, REASON);

    expect(store.updateTaskStatus).toHaveBeenCalledWith(expect.anything(), {
      id: "task-1",
      status: "failed",
      failureReason: REDACTED,
    });
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "coding/task/failed",
        data: { taskId: "task-1", reason: REDACTED },
      }),
    );
  });
});
