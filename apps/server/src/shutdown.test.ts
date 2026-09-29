import { describe, expect, it, vi } from "vitest";
import { type ServeResources, type ShutdownBounds, shutdownServe } from "./shutdown.js";
import { resolvesWithin } from "./test/assertions.js";

const FAST: ShutdownBounds = { webDrainMs: 100, stepMs: 300 };

/** Teardown resources whose steps are healthy stubs unless overridden. */
function resources(steps: Partial<ServeResources> = {}): ServeResources {
  return {
    web: { close: vi.fn(async () => {}) },
    adapters: [stoppable()],
    mcpRegistry: stoppable(),
    sandbox: { shutdown: vi.fn(async () => {}) },
    closeInstance: vi.fn(async () => {}),
    ...steps,
  };
}

function stoppable() {
  return { stop: vi.fn(async () => {}) };
}

function never(): Promise<void> {
  return new Promise(() => {});
}

describe("shutdownServe", () => {
  it("gives the web server its drain", async () => {
    const web = { close: vi.fn(async () => {}) };

    await shutdownServe(resources({ web }), FAST);

    expect(web.close).toHaveBeenCalledWith(FAST.webDrainMs);
  });

  it("moves past a step that never settles", async () => {
    const healthy = stoppable();
    const sandbox = { shutdown: vi.fn(async () => {}) };
    const closeInstance = vi.fn(async () => {});
    const deps = resources({
      adapters: [{ stop: never }, healthy],
      mcpRegistry: { stop: never },
      sandbox,
      closeInstance,
    });

    await resolvesWithin(shutdownServe(deps, FAST), 2_500, "shutdown");

    expect(healthy.stop).toHaveBeenCalledTimes(1);
    expect(sandbox.shutdown).toHaveBeenCalledTimes(1);
    expect(closeInstance).toHaveBeenCalledTimes(1);
  });

  it("moves past a step that throws", async () => {
    const closeInstance = vi.fn(async () => {});
    const deps = resources({
      sandbox: { shutdown: vi.fn().mockRejectedValue(new Error("daemon gone")) },
      closeInstance,
    });

    await expect(shutdownServe(deps, FAST)).resolves.toBeUndefined();
    expect(closeInstance).toHaveBeenCalledTimes(1);
  });

  it("skips the sandbox steps when there is no sandbox", async () => {
    const adapter = stoppable();

    await expect(
      shutdownServe(resources({ adapters: [adapter], sandbox: null, closeInstance: null }), FAST),
    ).resolves.toBeUndefined();
    expect(adapter.stop).toHaveBeenCalledTimes(1);
  });
});
