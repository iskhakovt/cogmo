import { describe, expect, it } from "vitest";
import { fromSessionResult } from "./session-result.js";

describe("fromSessionResult", () => {
  it("passes a result carrying `failure` through", () => {
    const failure = { reason: "cli_exit_error" as const, detail: "claude exit code 2" };
    expect(fromSessionResult({ isError: true, failure })).toEqual({ isError: true, failure });
  });

  it("reads a memo predating `failure` as a cli_exit_error with its text as the detail", () => {
    // A run in flight across the deploy memoized `{ isError, failureReason }`.
    expect(fromSessionResult({ isError: true, failureReason: "claude exit code 2" })).toEqual({
      isError: true,
      failure: { reason: "cli_exit_error", detail: "claude exit code 2" },
    });
  });

  it("keeps the plan and drops usage fields the backend did not report", () => {
    expect(
      fromSessionResult({
        isError: false,
        plan: "## Plan",
        usage: { inputTokens: 10, outputTokens: undefined },
      }),
    ).toEqual({ isError: false, plan: "## Plan", usage: { inputTokens: 10 } });
  });

  it("refuses a shape no session wrote", () => {
    expect(() =>
      fromSessionResult({ isError: true, failure: { reason: "nope", detail: "" } }),
    ).toThrow();
    expect(() => fromSessionResult({ isError: true, exitCode: 2 })).toThrow();
  });
});
