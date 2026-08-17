import type { Daytona } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import { disposeDaytona } from "./dispose.js";

/**
 * Structural stand-in for the SDK client: `disposeDaytona` reads exactly
 * one member off it, so a full `mock<Daytona>()` would only add noise —
 * and `mock<T>()`'s proxy doesn't produce well-known-symbol methods.
 */
function fakeDaytona(dispose: () => Promise<void>): Daytona {
  return { [Symbol.asyncDispose]: dispose } as unknown as Daytona;
}

describe("disposeDaytona", () => {
  it("calls the SDK's asyncDispose", async () => {
    const dispose = vi.fn(async () => {});
    await disposeDaytona(fakeDaytona(dispose));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("swallows a disposal failure and logs it", async () => {
    // Callers are shutting down or already reporting a prior failure; a
    // rejected disposal must not replace the outcome they carry.
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const dispose = vi.fn(async () => {
        throw new Error("socket already gone");
      });
      await expect(disposeDaytona(fakeDaytona(dispose))).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: "socket already gone" }),
        "disposing the Daytona SDK client failed — its event-stream socket may stay open",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
