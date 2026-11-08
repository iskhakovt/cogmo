import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { fakeRunInTx } from "../../test/factories.js";
import type { TaskOutcome } from "../protocol.js";
import type { SkillRunRow, SkillStore } from "../store/index.js";
import { failBeforeDispatch } from "./fail-before-dispatch.js";

const USAGE = { wallClockMs: 3, peakMemoryBytes: null };
const FINISHED_AT = new Date("2026-06-01T09:00:03Z");

function fail(store: SkillStore, result: TaskOutcome) {
  return failBeforeDispatch(
    { store, runInTx: fakeRunInTx },
    { id: "run-1", result, resourceUsage: USAGE, finishedAt: FINISHED_AT },
  );
}

describe("failBeforeDispatch", () => {
  it.each(["runtime_unavailable", "dependency_unavailable"] as const)(
    "records a %s the runtime reported, saying no skill code ran",
    async (kind) => {
      const store = mock<SkillStore>();
      store.failBeforeDispatch.mockResolvedValue({ kind: "transitioned" });

      const recorded = await fail(store, { ok: false, errorKind: kind, error: "pool disposed" });

      const error = { kind, message: "pool disposed (no skill code ran)" };
      expect(recorded).toEqual({
        outcome: { kind: "error", error },
        transition: { kind: "transitioned" },
      });
      expect(store.failBeforeDispatch).toHaveBeenCalledWith(expect.anything(), {
        id: "run-1",
        error,
        resourceUsage: USAGE,
        finishedAt: FINISHED_AT,
      });
    },
  );

  it("returns the swept row when the sweeper finished the run first", async () => {
    const store = mock<SkillStore>();
    const row = mock<SkillRunRow>({ errorKind: "host_lost" });
    store.failBeforeDispatch.mockResolvedValue({ kind: "swept", row });

    const recorded = await fail(store, {
      ok: false,
      errorKind: "runtime_unavailable",
      error: "task withheld",
    });

    expect(recorded.transition).toEqual({ kind: "swept", row });
  });

  it("throws, writing nothing, on an output or a kind only a sent task has", async () => {
    const store = mock<SkillStore>();

    await expect(fail(store, { ok: true, output: 1 })).rejects.toThrow(
      /returned an output for a task it never sent/,
    );
    await expect(
      fail(store, { ok: false, errorKind: "result_lost", error: "supervisor_unresponsive" }),
    ).rejects.toThrow(/reported result_lost for a task it never sent/);
    expect(store.failBeforeDispatch).not.toHaveBeenCalled();
  });
});
