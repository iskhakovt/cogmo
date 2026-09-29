import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finishesWithin } from "./finishes-within.js";

describe("finishesWithin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is true for work that resolves before the deadline", async () => {
    const result = finishesWithin(Promise.resolve(), 100);

    await expect(result).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is false for work still pending at the deadline", async () => {
    const result = finishesWithin(new Promise(() => {}), 100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe(false);
  });

  it("propagates a rejection", async () => {
    await expect(finishesWithin(Promise.reject(new Error("boom")), 100)).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});
