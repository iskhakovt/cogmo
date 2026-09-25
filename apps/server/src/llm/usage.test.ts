import { describe, expect, it } from "vitest";
import { sumUsage } from "./usage.js";

describe("sumUsage", () => {
  it("adds every count, cache reads and writes included", () => {
    expect(
      sumUsage(
        { inputTokens: 7440, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 7430 },
        { inputTokens: 7520, outputTokens: 9, cacheReadTokens: 7430, cacheCreationTokens: 80 },
      ),
    ).toEqual({
      inputTokens: 14_960,
      outputTokens: 39,
      cacheReadTokens: 7430,
      cacheCreationTokens: 7510,
    });
  });

  it("keeps a cache field once either side reports it", () => {
    expect(
      sumUsage(
        { inputTokens: 100, outputTokens: 5 },
        { inputTokens: 120, outputTokens: 5, cacheReadTokens: 90 },
      ),
    ).toEqual({ inputTokens: 220, outputTokens: 10, cacheReadTokens: 90 });
  });

  it("leaves the cache fields off when neither side reports them", () => {
    expect(
      sumUsage({ inputTokens: 10, outputTokens: 5 }, { inputTokens: 20, outputTokens: 1 }),
    ).toEqual({ inputTokens: 30, outputTokens: 6 });
  });
});
