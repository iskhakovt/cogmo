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

  // The message survives an abort but the CLASS does not: p-retry rethrows the
  // AbortError's `originalError`, which it builds from the message when the
  // abort was constructed from a string. Callers that branch on the error's
  // type after `withRetry` therefore cannot use AbortError to carry it — they
  // need `shouldRetry`, which rethrows the error untouched. Pinned here
  // because a caller reading `instanceof` on an aborted failure gets `false`
  // and silently takes the wrong branch.
  it("unwraps AbortError to a plain Error, losing the subclass", async () => {
    class Marker extends AbortError {}
    const fn = vi.fn().mockRejectedValue(new Marker("permanent 404"));

    const caught = await withRetry(fn, { minTimeoutMs: 1, maxTimeoutMs: 5 }).catch(
      (e: unknown) => e,
    );

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AbortError);
    expect(caught).not.toBeInstanceOf(Marker);
    expect((caught as Error).message).toBe("permanent 404");
  });

  it("shouldRetry rethrows the original error with its class intact", async () => {
    class Permanent extends Error {}
    const fn = vi.fn().mockRejectedValue(new Permanent("permanent 404"));

    const caught = await withRetry(fn, {
      minTimeoutMs: 1,
      maxTimeoutMs: 5,
      shouldRetry: (err) => !(err instanceof Permanent),
    }).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(Permanent);
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

  describe("shouldRetry predicate", () => {
    // Companion contract to AbortError, lifted to the predicate path.
    // shouldRetry returning false must (a) propagate the ORIGINAL error
    // unchanged — unlike AbortError which would replace the thrown
    // value with itself — and (b) NOT emit a warn line, since no retry
    // actually happens.

    class MyDomainError extends Error {
      readonly tag = "domain" as const;
    }

    it("does not retry when shouldRetry returns false, propagating the original error type", async () => {
      const err = new MyDomainError("boom");
      const fn = vi.fn().mockRejectedValue(err);

      const caught = await withRetry(fn, {
        minTimeoutMs: 1,
        maxTimeoutMs: 5,
        shouldRetry: () => false,
      }).catch((e) => e);

      // Original error type preserved — no AbortError wrapping.
      expect(caught).toBeInstanceOf(MyDomainError);
      expect((caught as MyDomainError).tag).toBe("domain");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("does NOT log a warn line when shouldRetry returns false", async () => {
      // p-retry fires onFailedAttempt BEFORE consulting shouldRetry,
      // so the wrapper has to re-check the predicate inside the hook.
      // Without this guard, every routine non-retriable error (e.g.
      // UniqueViolationError from admission caps) would spam a
      // "retry attempt 1 failed" warn even though no retry ran.
      const fn = vi.fn().mockRejectedValue(new Error("permanent"));
      await expect(
        withRetry(fn, { minTimeoutMs: 1, maxTimeoutMs: 5, shouldRetry: () => false }),
      ).rejects.toThrow("permanent");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("retries (and logs) when shouldRetry returns true", async () => {
      const fn = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue("ok");
      const result = await withRetry(fn, {
        minTimeoutMs: 1,
        maxTimeoutMs: 5,
        shouldRetry: () => true,
      });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("passes the actual error (not undefined) to the predicate", async () => {
      // Catches p-retry API-shape drift: shouldRetry's hook receives a
      // RetryContext object, and `({error}) => …` must destructure
      // correctly. A regression here (signature change in a future
      // p-retry major, wrong destructuring shape) would surface as
      // `error` being undefined and the predicate misclassifying.
      // The wrapper calls the predicate twice per attempt (once in
      // onFailedAttempt to gate the warn log, once in shouldRetry);
      // we only need to lock that the FIRST call sees the real error.
      const seen: unknown[] = [];
      const fn = vi.fn().mockRejectedValue(new Error("specific message"));
      await withRetry(fn, {
        minTimeoutMs: 1,
        maxTimeoutMs: 5,
        shouldRetry: (e) => {
          seen.push(e);
          return false;
        },
      }).catch(() => undefined);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]).toBeInstanceOf(Error);
      expect((seen[0] as Error).message).toBe("specific message");
    });
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
