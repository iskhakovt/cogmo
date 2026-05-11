import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { scheduleReconcileCrashedInstances } from "./index.js";
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
