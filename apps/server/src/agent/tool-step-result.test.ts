import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { fromToolStepResult, toToolStepResult } from "./tool-step-result.js";

/** What a memoized step result looks like after the Inngest server re-encodes it. */
function memoized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("tool step result", () => {
  it("round-trips a success through a JSON memo", () => {
    const memo = memoized(toToolStepResult(ok("wrote x")));

    expect(fromToolStepResult(memo)).toEqual(ok("wrote x"));
  });

  it("round-trips a rejection through a JSON memo", () => {
    const memo = memoized(toToolStepResult(err({ message: "no such path" })));

    expect(memo).toEqual({ ok: false, message: "no such path" });
    expect(fromToolStepResult(memo)).toEqual(err({ message: "no such path" }));
  });

  it("reads a bare string as a success", () => {
    expect(fromToolStepResult("legacy output")).toEqual(ok("legacy output"));
  });

  it("throws on a memo of neither shape", () => {
    expect(() => fromToolStepResult({ ok: false })).toThrow();
    expect(() => fromToolStepResult(42)).toThrow();
  });
});
