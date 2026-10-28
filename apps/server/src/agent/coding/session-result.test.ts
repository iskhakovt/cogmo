import { describe, expect, it } from "vitest";
import { fromSessionResult } from "./session-result.js";

const failure = { reason: "cli_exit_error" as const, detail: "claude exit code 2" };

describe("fromSessionResult", () => {
  it("reads an errored memo as its failure", () => {
    expect(fromSessionResult({ kind: "errored", failure })).toEqual({ kind: "errored", failure });
  });

  it("reads a completed memo with its plan, dropping usage fields the backend did not report", () => {
    expect(
      fromSessionResult({
        kind: "completed",
        plan: "## Plan",
        usage: { inputTokens: 10, outputTokens: undefined },
      }),
    ).toEqual({ kind: "completed", plan: "## Plan", usage: { inputTokens: 10 } });
    expect(fromSessionResult({ kind: "completed" })).toEqual({ kind: "completed" });
  });

  describe("a memo from a run in flight across the deploy", () => {
    it("reads `{ isError, failure }` as its failure", () => {
      expect(fromSessionResult({ isError: true, failure })).toEqual({ kind: "errored", failure });
    });

    it("reads `{ isError, failureReason }` as a cli_exit_error with its text as the detail", () => {
      expect(fromSessionResult({ isError: true, failureReason: "claude exit code 2" })).toEqual({
        kind: "errored",
        failure,
      });
    });

    it("reads `{ isError: false }` as completed, with its plan and reported usage", () => {
      expect(
        fromSessionResult({
          isError: false,
          plan: "## Plan",
          usage: { inputTokens: 10, outputTokens: undefined },
        }),
      ).toEqual({ kind: "completed", plan: "## Plan", usage: { inputTokens: 10 } });
      expect(fromSessionResult({ isError: false })).toEqual({ kind: "completed" });
    });
  });

  it("refuses a shape no session wrote", () => {
    expect(() =>
      fromSessionResult({ kind: "errored", failure: { reason: "nope", detail: "" } }),
    ).toThrow();
    expect(() => fromSessionResult({ kind: "errored" })).toThrow();
    expect(() => fromSessionResult({ kind: "completed", isError: false })).toThrow();
    expect(() => fromSessionResult({ isError: true, exitCode: 2 })).toThrow();
    // Errored without saying why.
    expect(() => fromSessionResult({ isError: true })).toThrow();
  });
});
