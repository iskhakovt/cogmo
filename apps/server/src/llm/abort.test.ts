import { describe, expect, it } from "vitest";
import { abortReasonOr } from "./abort.js";

describe("abortReasonOr", () => {
  it("passes the error through while the signal has not fired", () => {
    const err = new Error("boom");
    expect(abortReasonOr(err, undefined)).toBe(err);
    expect(abortReasonOr(err, new AbortController().signal)).toBe(err);
  });

  it("substitutes the reason once the signal has fired", () => {
    const reason = new Error("cancelled");
    expect(abortReasonOr(new Error("APIUserAbortError"), AbortSignal.abort(reason))).toBe(reason);
  });
});
