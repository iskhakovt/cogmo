import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import {
  BOOT_WARM_MAX_ATTEMPTS,
  scheduleReconcileCrashedInstances,
  scheduleSandboxImageWarm,
} from "./index.js";
import { logger } from "./logger.js";
import type { SandboxClient } from "./sandbox/index.js";

describe("scheduleReconcileCrashedInstances", () => {
  it("logs a warn with backendLabel + orphansReaped when reconcile returns a non-zero count", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const client = mock<SandboxClient>({ backendId: "test-backend" });
      const reconcileResult = Promise.resolve({ orphansReaped: 3 });
      client.reconcileCrashedInstances.mockReturnValue(reconcileResult);

      scheduleReconcileCrashedInstances(client, "inst-1");

      // Drain the helper's `.then` microtask — `reconcileResult` is already
      // resolved, so a single await on it lets the registered callback fire
      // before our continuation observes the spy.
      await reconcileResult;
      await Promise.resolve();

      expect(client.reconcileCrashedInstances).toHaveBeenCalledWith("inst-1");
      expect(warnSpy).toHaveBeenCalledWith(
        { orphansReaped: 3, backendLabel: "test-backend" },
        "reaped orphan sandboxes from prior instance(s)",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("stays silent when reconcile reports zero orphans", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const client = mock<SandboxClient>({ backendId: "test-backend" });
      const reconcileResult = Promise.resolve({ orphansReaped: 0 });
      client.reconcileCrashedInstances.mockReturnValue(reconcileResult);

      scheduleReconcileCrashedInstances(client, "inst-2");

      await reconcileResult;
      await Promise.resolve();

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs an error and does not throw when reconcile rejects", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    try {
      const client = mock<SandboxClient>({ backendId: "test-backend" });
      const reconcileErr = new Error("daemon unreachable");
      // Pre-handle the rejection inline so the bare-promise rejection
      // doesn't get logged by vitest's `unhandledRejection` listener — the
      // helper attaches its own onRejected handler downstream of this one,
      // but the test holds the mock-returned promise directly and needs
      // its own safety net.
      const reconcileResult = Promise.reject(reconcileErr);
      reconcileResult.catch(() => null);
      client.reconcileCrashedInstances.mockReturnValue(reconcileResult);

      expect(() => scheduleReconcileCrashedInstances(client, "inst-3")).not.toThrow();

      await reconcileResult.catch(() => null);
      await Promise.resolve();

      expect(errorSpy).toHaveBeenCalledWith(
        { err: reconcileErr, instanceId: "inst-3", backendLabel: "test-backend" },
        "background reconcileCrashedInstances failed",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("scheduleSandboxImageWarm (bounded boot retry)", () => {
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
      scheduleSandboxImageWarm(client, ["img:1.0"]);
      await vi.runAllTimersAsync();
      expect(client.ensureImagePresent).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith(
        { image: "img:1.0", attempt: 0 },
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

    scheduleSandboxImageWarm(client, ["img:1.0"]);
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
      scheduleSandboxImageWarm(client, ["img:1.0"]);
      await vi.runAllTimersAsync();
      expect(client.ensureImagePresent).toHaveBeenCalledTimes(BOOT_WARM_MAX_ATTEMPTS);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "img:1.0",
          attempts: BOOT_WARM_MAX_ATTEMPTS,
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

    scheduleSandboxImageWarm(client, ["slow:1", "fast:1"]);
    await vi.runAllTimersAsync();
    const slowCalls = client.ensureImagePresent.mock.calls.filter(([i]) => i === "slow:1").length;
    const fastCalls = client.ensureImagePresent.mock.calls.filter(([i]) => i === "fast:1").length;
    expect(slowCalls).toBe(3);
    expect(fastCalls).toBe(1);
  });
});
