import { describe, expect, it } from "vitest";
import type { SkillRunErrorKind, SkillRunRow } from "../store/index.js";
import {
  finishedVerdictOf,
  reconstructFinishedResult,
  runErrorOf,
  type SkillRunErrorClass,
  skillRunErrorClass,
} from "./run-result.js";

function finishedRow(fields: Pick<SkillRunRow, "status" | "output" | "error" | "errorKind">) {
  return { id: "run-1", ...fields };
}

describe("skillRunErrorClass", () => {
  it.each<[SkillRunErrorKind, SkillRunErrorClass]>([
    ["skill_raised", "defect"],
    ["output_invalid", "defect"],
    ["load_failed", "defect"],
    ["wall_clock_exceeded", "defect"],
    ["memory_exceeded", "defect"],
    ["skill_failed", "expected"],
    ["input_invalid", "expected"],
    ["skill_retryable", "pausing"],
    ["runtime_unavailable", "pausing"],
    ["dependency_unavailable", "pausing"],
    ["egress_unavailable", "pausing"],
    ["credential_unavailable", "pausing"],
    ["host_lost", "pausing"],
    ["result_lost", "lost"],
    ["unknown", "legacy"],
  ])("classes %s as %s", (kind, errorClass) => {
    expect(skillRunErrorClass(kind)).toBe(errorClass);
  });
});

describe("runErrorOf", () => {
  it("reads no error from a row without one", () => {
    expect(runErrorOf({ id: "run-1", output: { n: 1 }, error: null, errorKind: null })).toBeNull();
  });

  it("reads an error with its kind, and the output only an output_invalid keeps", () => {
    expect(
      runErrorOf({ id: "run-1", output: null, error: "boom", errorKind: "load_failed" }),
    ).toEqual({ kind: "load_failed", message: "boom" });
    expect(
      runErrorOf({ id: "run-1", output: { n: "x" }, error: "bad", errorKind: "output_invalid" }),
    ).toEqual({ kind: "output_invalid", message: "bad", output: { n: "x" } });
  });

  it("throws on an error with no kind, which the CHECK rules out", () => {
    expect(() => runErrorOf({ id: "run-1", output: null, error: "boom", errorKind: null })).toThrow(
      /run-1 has an error and no error_kind/,
    );
  });
});

describe("finishedVerdictOf", () => {
  it("reads a success verdict with its output, null included", () => {
    expect(
      finishedVerdictOf(
        finishedRow({ status: "success", output: { n: 1 }, error: null, errorKind: null }),
      ),
    ).toEqual({ status: "success", output: { n: 1 } });
    expect(
      finishedVerdictOf(
        finishedRow({ status: "success", output: null, error: null, errorKind: null }),
      ),
    ).toEqual({ status: "success", output: null });
  });

  it("reads an error verdict with its kind and reason", () => {
    expect(
      finishedVerdictOf(
        finishedRow({ status: "error", output: null, error: "boom", errorKind: "result_lost" }),
      ),
    ).toEqual({ status: "error", error: { kind: "result_lost", message: "boom" } });
  });

  it("throws on a row outside the finished shape the CHECKs guarantee", () => {
    expect(() =>
      finishedVerdictOf(
        finishedRow({ status: "error", output: null, error: null, errorKind: null }),
      ),
    ).toThrow(/run-1 finished with status 'error' and no error/);
    expect(() =>
      finishedVerdictOf(
        finishedRow({ status: "running", output: null, error: null, errorKind: null }),
      ),
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

  it("carries an error's kind and reason", () => {
    expect(
      reconstructFinishedResult("run-1", {
        status: "error",
        error: { kind: "skill_raised", message: "boom" },
      }),
    ).toEqual({ runId: "run-1", status: "error", errorKind: "skill_raised", error: "boom" });
  });

  it("carries the output an output_invalid kept, and omits the key when it kept none", () => {
    expect(
      reconstructFinishedResult("run-1", {
        status: "error",
        error: { kind: "output_invalid", message: "bad", output: { n: "x" } },
      }),
    ).toEqual({
      runId: "run-1",
      status: "error",
      errorKind: "output_invalid",
      error: "bad",
      output: { n: "x" },
    });
    expect(
      reconstructFinishedResult("run-1", {
        status: "error",
        error: { kind: "output_invalid", message: "not JSON", output: null },
      }),
    ).toEqual({ runId: "run-1", status: "error", errorKind: "output_invalid", error: "not JSON" });
  });
});
