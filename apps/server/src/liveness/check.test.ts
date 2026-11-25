import { describe, expect, it } from "vitest";
import { ageSeconds, normalizeCode } from "./check.js";

describe("normalizeCode", () => {
  it.each([
    ["401", "401"],
    ["ECONNRESET", "ECONNRESET"],
    ["UND_ERR_SOCKET", "UND_ERR_SOCKET"],
    ["request-timeout", "request-timeout"],
    ["invalid-json", "invalid-json"],
  ])("keeps %s", (code, expected) => {
    expect(normalizeCode(code)).toBe(expected);
  });

  it.each([
    "",
    "Unauthorized",
    "request to https://api.telegram.org/bot123:abc/getUpdates failed",
    "123:abc",
    "ETIMEDOUT ",
    "-1",
  ])("replaces %j with unknown", (code) => {
    expect(normalizeCode(code)).toBe("unknown");
  });
});

describe("ageSeconds", () => {
  it("floors to whole seconds", () => {
    expect(ageSeconds(1_000, 3_999)).toBe(2);
  });

  it("never goes negative", () => {
    expect(ageSeconds(5_000, 4_000)).toBe(0);
  });
});
