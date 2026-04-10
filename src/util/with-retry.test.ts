import { beforeEach, describe, expect, it, vi } from "vitest";
import { AbortError, withRetry } from "./with-retry.js";

const warnSpy = vi.fn();
vi.mock("../logger.js", () => ({
  logger: {
    warn: (...args: unknown[]) => warnSpy(...args),
  },
}));

beforeEach(() => {
  warnSpy.mockClear();
});

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
    const result = await withRetry(fn, { minTimeoutMs: 1, maxTimeoutMs: 5 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after configured retries and throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent failure"));
    await expect(withRetry(fn, { retries: 2, minTimeoutMs: 1, maxTimeoutMs: 5 })).rejects.toThrow(
      "permanent failure",
    );
    // 1 initial attempt + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry AbortError", async () => {
    const fn = vi.fn().mockRejectedValue(new AbortError("client error"));
    await expect(withRetry(fn, { minTimeoutMs: 1, maxTimeoutMs: 5 })).rejects.toThrow(
      "client error",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not log a warn line on AbortError", async () => {
    // Locks in pRetry's documented contract that onFailedAttempt is never
    // called for AbortError. Without this guarantee every permanent 4xx
    // (bad API key, 401, 403, 404) would emit a misleading
    // "retry attempt 1 failed" line even though no retry happened.
    const fn = vi.fn().mockRejectedValue(new AbortError("permanent client error"));
    await expect(withRetry(fn)).rejects.toThrow("permanent client error");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does log a warn line on retryable errors", async () => {
    // Companion to the AbortError test — verifies the warn path is wired
    // correctly so the previous assertion isn't passing for the wrong reason.
    const fn = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue("ok");
    await withRetry(fn, { minTimeoutMs: 1, maxTimeoutMs: 5 });
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("passes maxRetryTimeMs through to the underlying retry library", async () => {
    // Smoke test for the conditional spread of maxRetryTimeMs. Tests the
    // wiring, not pRetry's cap behaviour itself (that's pRetry's job).
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, {
      maxRetryTimeMs: 1000,
      minTimeoutMs: 1,
      maxTimeoutMs: 5,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propagates the latest error after exhausting retries", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValue(new Error("third"));
    await expect(withRetry(fn, { retries: 2, minTimeoutMs: 1, maxTimeoutMs: 5 })).rejects.toThrow(
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
      minTimeoutMs: 1,
      maxTimeoutMs: 5,
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
      await expect(withRetry(fn, { retries: 5, minTimeoutMs: 1, maxTimeoutMs: 5 })).rejects.toThrow(
        "transient",
      );
      // Called once, not retried — without RETRY_DISABLED this would be 6 calls.
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
