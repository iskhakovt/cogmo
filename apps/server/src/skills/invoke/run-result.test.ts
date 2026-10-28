import { describe, expect, it } from "vitest";
import type { SkillRunRow } from "../store/index.js";
import { finishedVerdictOf, reconstructFinishedResult } from "./run-result.js";

function finishedRow(fields: Pick<SkillRunRow, "status" | "output" | "error">) {
  return { id: "run-1", ...fields };
}

describe("finishedVerdictOf", () => {
  it("reads a success verdict with its output, null included", () => {
    expect(
      finishedVerdictOf(finishedRow({ status: "success", output: { n: 1 }, error: null })),
    ).toEqual({ status: "success", output: { n: 1 } });
    expect(
      finishedVerdictOf(finishedRow({ status: "success", output: null, error: null })),
    ).toEqual({ status: "success", output: null });
  });

  it("reads an error verdict with its reason", () => {
    expect(
      finishedVerdictOf(finishedRow({ status: "error", output: null, error: "boom" })),
    ).toEqual({ status: "error", error: "boom" });
  });

  it("throws on a row outside the finished shape the CHECKs guarantee", () => {
    expect(() =>
      finishedVerdictOf(finishedRow({ status: "error", output: null, error: null })),
    ).toThrow(/run-1 finished with status 'error' and no error/);
    expect(() =>
      finishedVerdictOf(finishedRow({ status: "running", output: null, error: null })),
    ).toThrow(/run-1 finished with status 'running'/);
  });
});

describe("reconstructFinishedResult", () => {
  it("carries a success output and omits the key when there is none", () => {
    expect(reconstructFinishedResult("run-1", { status: "success", output: { n: 1 } })).toEqual({
      runId: "run-1",
      status: "success",
      output: { n: 1 },
    });
    expect(reconstructFinishedResult("run-1", { status: "success", output: null })).toEqual({
      runId: "run-1",
      status: "success",
    });
  });

  it("carries an error reason", () => {
    expect(reconstructFinishedResult("run-1", { status: "error", error: "boom" })).toEqual({
      runId: "run-1",
      status: "error",
      error: "boom",
    });
  });
});
