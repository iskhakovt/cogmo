import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { ExecError, type ExecFailure, execFailureError, unwrapExit } from "./exec.js";

describe("execFailureError", () => {
  it.each<[ExecFailure, string]>([
    [
      { kind: "timed_out", deadline: "total", timeoutMs: 50 },
      "exec exceeded wall-clock timeout 50ms",
    ],
    [
      { kind: "timed_out", deadline: "idle", timeoutMs: 20 },
      "exec exceeded idle timeout 20ms with no stdout/stderr activity",
    ],
    [{ kind: "disposed" }, "exec was disposed"],
    [{ kind: "no_exit_code", reason: "exec never reaped" }, "exec never reaped"],
  ])("carries a lifecycle failure on an ExecError: %o", (failure, message) => {
    const error = execFailureError(failure);
    expect(error).toBeInstanceOf(ExecError);
    expect(error).toMatchObject({ failure, message, name: "ExecError" });
  });

  it("passes the transport's own error through", () => {
    const transportError = new Error("upstream WS dropped");
    expect(execFailureError({ kind: "transport_failed", error: transportError })).toBe(
      transportError,
    );
  });
});

describe("unwrapExit", () => {
  it("returns the exit", () => {
    expect(unwrapExit(ok({ exitCode: 3 }))).toEqual({ exitCode: 3 });
  });

  it("throws the failure's error", () => {
    expect(() => unwrapExit(err({ kind: "disposed" }))).toThrow(
      new ExecError({ kind: "disposed" }),
    );
  });
});
