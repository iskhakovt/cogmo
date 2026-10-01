import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { logger } from "../logger.js";
import type { SandboxClient } from "../sandbox/index.js";
import { BOOT_WARM_MAX_ATTEMPTS, scheduleSandboxImageWarm } from "./sandbox-image-warm.js";

describe("scheduleSandboxImageWarm (bounded boot retry)", () => {
  const TEST_LIMITS = { cpus: 1, memory_bytes: 512 * 1024 * 1024, pids: 256 };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds on first attempt without scheduling a retry", async () => {
    const client = mock<SandboxClient>();
    client.ensureImagePresent.mockResolvedValue();
    const infoSpy = vi.spyOn(logger, "info");
    try {
      scheduleSandboxImageWarm(client, [{ image: "img:1.0", resourceLimits: TEST_LIMITS }]);
      await vi.runAllTimersAsync();
      expect(client.ensureImagePresent).toHaveBeenCalledTimes(1);
      expect(client.ensureImagePresent).toHaveBeenCalledWith("img:1.0", TEST_LIMITS);
      expect(infoSpy).toHaveBeenCalledWith(
        { image: "img:1.0", attempt: 1 },
        "sandbox image warm complete",
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("retries on transient failure and succeeds on a later attempt", async () => {
    const client = mock<SandboxClient>();
    client.ensureImagePresent
      .mockRejectedValueOnce(new Error("transient 1"))
      .mockRejectedValueOnce(new Error("transient 2"))
      .mockResolvedValue();

    scheduleSandboxImageWarm(client, [{ image: "img:1.0", resourceLimits: TEST_LIMITS }]);
    // First attempt fires synchronously, fails; subsequent retries
    // wait on the timer. Drain the entire schedule.
    await vi.runAllTimersAsync();
    expect(client.ensureImagePresent).toHaveBeenCalledTimes(3);
  });

  it("gives up after MAX_ATTEMPTS with a structured warn and never throws", async () => {
    const client = mock<SandboxClient>();
    client.ensureImagePresent.mockRejectedValue(new Error("provider down"));
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      scheduleSandboxImageWarm(client, [{ image: "img:1.0", resourceLimits: TEST_LIMITS }]);
      await vi.runAllTimersAsync();
      expect(client.ensureImagePresent).toHaveBeenCalledTimes(BOOT_WARM_MAX_ATTEMPTS);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "img:1.0",
          attemptsTaken: BOOT_WARM_MAX_ATTEMPTS,
        }),
        "background sandbox image warm exhausted retries — task path will retry on first use",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("schedules each image independently — one slow image doesn't block the others", async () => {
    const client = mock<SandboxClient>();
    client.ensureImagePresent.mockImplementation((image: string) => {
      // First image fails twice then succeeds; second image succeeds
      // immediately. Both loops must run to completion regardless of
      // ordering.
      if (image === "slow:1") {
        const call = client.ensureImagePresent.mock.calls.filter(([i]) => i === "slow:1").length;
        if (call <= 2) return Promise.reject(new Error("flake"));
      }
      return Promise.resolve();
    });

    scheduleSandboxImageWarm(client, [
      { image: "slow:1", resourceLimits: TEST_LIMITS },
      { image: "fast:1", resourceLimits: TEST_LIMITS },
    ]);
    await vi.runAllTimersAsync();
    const slowCalls = client.ensureImagePresent.mock.calls.filter(([i]) => i === "slow:1").length;
    const fastCalls = client.ensureImagePresent.mock.calls.filter(([i]) => i === "fast:1").length;
    expect(slowCalls).toBe(3);
    expect(fastCalls).toBe(1);
  });
});
