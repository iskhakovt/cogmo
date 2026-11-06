import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { fakeRunInTx } from "../../test/factories.js";
import type { SkillRunRow, SkillStore } from "../store/index.js";
import { dispatchDeadline, dispatchRun } from "./dispatch-run.js";

const NOW = new Date("2026-06-01T09:00:00Z");

describe("dispatchDeadline", () => {
  it("is the wall clock plus 60 s for the kill, the result frame and teardown", () => {
    expect(dispatchDeadline(NOW, 30)).toEqual(new Date("2026-06-01T09:01:30Z"));
    expect(dispatchDeadline(NOW, 300)).toEqual(new Date("2026-06-01T09:06:00Z"));
  });
});

describe("dispatchRun", () => {
  it("sends once the row is dispatched, writing the deadline", async () => {
    const store = mock<SkillStore>();
    store.transitionToDispatched.mockResolvedValue({ kind: "dispatched" });

    const decision = await dispatchRun(
      { store, runInTx: fakeRunInTx },
      { runId: "run-1", deadlineAt: NOW },
    );

    expect(decision).toEqual({ kind: "send" });
    expect(store.transitionToDispatched).toHaveBeenCalledWith(expect.anything(), {
      id: "run-1",
      deadlineAt: NOW,
    });
  });

  it("withholds the task from a run the sweeper finished", async () => {
    const store = mock<SkillStore>();
    store.transitionToDispatched.mockResolvedValue({ kind: "swept", row: mock<SkillRunRow>() });

    const decision = await dispatchRun(
      { store, runInTx: fakeRunInTx },
      { runId: "run-1", deadlineAt: NOW },
    );

    expect(decision).toEqual({ kind: "withhold" });
  });
});
