import { describe, expect, it, vi } from "vitest";
import { AbortError, withRetry } from "./with-retry.js";

describe("withRetry", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient 1"))
      .mockRejectedValueOnce(new Error("transient 2"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { minTimeout: 1, maxTimeout: 5 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after configured retries and throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent failure"));
    await expect(withRetry(fn, { retries: 2, minTimeout: 1, maxTimeout: 5 })).rejects.toThrow(
      "permanent failure",
    );
    // 1 initial attempt + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry AbortError", async () => {
    const fn = vi.fn().mockRejectedValue(new AbortError("client error"));
    await expect(withRetry(fn, { minTimeout: 1, maxTimeout: 5 })).rejects.toThrow("client error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propagates the latest error after exhausting retries", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValue(new Error("third"));
    await expect(withRetry(fn, { retries: 2, minTimeout: 1, maxTimeout: 5 })).rejects.toThrow(
      "third",
    );
  });

  it("includes context in failure logs when provided", async () => {
    // Exercises the truthy branch of the context label in the log line.
    // We don't assert the log output (the logger is a real pino instance);
    // we just verify the call still completes successfully when context
    // is set, which is enough to cover the conditional template branch.
    const fn = vi.fn().mockRejectedValueOnce(new Error("flake")).mockResolvedValue("ok");
    const result = await withRetry(fn, {
      minTimeout: 1,
      maxTimeout: 5,
      context: "test.context",
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("skips retries entirely when RETRY_DISABLED env var is set", async () => {
    // Integration and e2e tests opt out of retries via this env var so
    // transient failures surface as hard failures instead of being masked.
    vi.stubEnv("RETRY_DISABLED", "true");
    try {
      const fn = vi.fn().mockRejectedValue(new Error("transient"));
      await expect(withRetry(fn, { retries: 5, minTimeout: 1, maxTimeout: 5 })).rejects.toThrow(
        "transient",
      );
      // Called once, not retried — without RETRY_DISABLED this would be 6 calls.
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
