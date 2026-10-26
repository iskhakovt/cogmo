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

describe("task failure channel", () => {
  it.each([
    [
      "recordTaskFailed",
      (h: ReturnType<typeof harness>) =>
        recordTaskFailed(h.run, h.deps, REASON, "set-status-failed"),
    ],
    [
      "failTaskFromCatch",
      (h: ReturnType<typeof harness>) => failTaskFromCatch(h.run, h.deps, REASON),
    ],
  ])("%s persists, emits and returns the masked reason", async (_name, fail) => {
    const h = harness();

    const recorded = await fail(h);

    expect(recorded).toBe(MASKED);
    expect(h.store.updateTaskStatus).toHaveBeenCalledWith(expect.anything(), {
      id: "task-1",
      status: "failed",
      failureReason: MASKED,
    });
    expect(h.inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "coding/task/failed",
        data: { taskId: "task-1", reason: MASKED },
      }),
    );
  });
});
