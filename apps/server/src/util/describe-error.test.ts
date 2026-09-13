import { describe, expect, it } from "vitest";
import { describeError } from "./describe-error.js";

describe("describeError", () => {
  it("returns the message of an error without a cause", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("appends the cause's message, where fetch keeps the network reason", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8888"), {
      code: "ECONNREFUSED",
    });

    expect(describeError(new TypeError("fetch failed", { cause }))).toBe(
      "fetch failed (connect ECONNREFUSED 127.0.0.1:8888)",
    );
  });

  it("falls back to the cause's code when its message is empty", () => {
    const cause = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });

    expect(describeError(new TypeError("fetch failed", { cause }))).toBe(
      "fetch failed (ECONNREFUSED)",
    );
  });

  it("ignores a cause that is neither an Error nor informative", () => {
    expect(describeError(new Error("boom", { cause: "not an error" }))).toBe("boom");
    expect(describeError(new Error("boom", { cause: new AggregateError([], "") }))).toBe("boom");
  });

  it("stringifies a thrown non-Error", () => {
    expect(describeError("plain string")).toBe("plain string");
  });
});
