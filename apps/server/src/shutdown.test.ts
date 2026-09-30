import { afterEach, describe, expect, it, vi } from "vitest";
import { type ServeResources, type ShutdownBounds, shutdownServe } from "./shutdown.js";

const BOUNDS: ShutdownBounds = { webDrainMs: 100, stepMs: 300 };

/** Teardown resources whose steps are healthy stubs unless overridden. */
function resources(steps: Partial<ServeResources> = {}): ServeResources {
  return {
    web: { close: vi.fn(async () => {}) },
    adapters: [channel("telegram", async () => {})],
    codingStreams: { close: vi.fn() },
    mcpRegistry: { stop: vi.fn(async () => {}) },
    skills: { shutdown: vi.fn(async () => {}) },
    sandbox: { shutdown: vi.fn(async () => {}) },
    closeInstance: vi.fn(async () => {}),
    ...steps,
  };
}

function channel(channelType: string, stop: () => Promise<void>) {
  return { channelType, adapter: { stop: vi.fn(stop) } };
}

function never(): Promise<void> {
  return new Promise(() => {});
}

/** Steps that record when they start and end, finishing a macrotask after they start. */
function recorder() {
  const events: string[] = [];
  const step = (name: string) => async () => {
    events.push(`${name} start`);
    await new Promise((resolve) => setImmediate(resolve));
    events.push(`${name} end`);
  };
  return { events, step };
}

describe("shutdownServe", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the web server its drain", async () => {
    const web = { close: vi.fn(async () => {}) };

    await shutdownServe(resources({ web }), BOUNDS);

    expect(web.close).toHaveBeenCalledWith(BOUNDS.webDrainMs);
  });

  it("finishes each step before the next starts", async () => {
    const { events, step } = recorder();

    await shutdownServe(
      resources({
        web: { close: step("web") },
        adapters: [channel("telegram", step("telegram"))],
        codingStreams: { close: () => events.push("coding streams") },
        mcpRegistry: { stop: step("mcp") },
        skills: { shutdown: step("skills") },
        sandbox: { shutdown: step("sandbox") },
        closeInstance: step("instance"),
      }),
      BOUNDS,
    );

    expect(events).toEqual([
      "web start",
      "web end",
      "telegram start",
      "telegram end",
      "coding streams",
      "mcp start",
      "mcp end",
      "skills start",
      "skills end",
      "sandbox start",
      "sandbox end",
      "instance start",
      "instance end",
    ]);
  });

  it("stops the channel adapters concurrently", async () => {
    const { events, step } = recorder();

    await shutdownServe(
      resources({ adapters: [channel("telegram", step("telegram")), channel("web", step("web"))] }),
      BOUNDS,
    );

    expect(events).toEqual(["telegram start", "web start", "telegram end", "web end"]);
  });

  it("reports every step, adapters by channel", async () => {
    const outcomes = await shutdownServe(
      resources({
        adapters: [channel("telegram", async () => {}), channel("web", async () => {})],
      }),
      BOUNDS,
    );

    expect(outcomes).toEqual([
      { step: "web server", outcome: "done" },
      { step: "telegram adapter", outcome: "done" },
      { step: "web adapter", outcome: "done" },
      { step: "coding streams", outcome: "done" },
      { step: "mcp", outcome: "done" },
      { step: "skills pool", outcome: "done" },
      { step: "sandbox", outcome: "done" },
      { step: "sandbox instance", outcome: "done" },
    ]);
  });

  it("reports a step that overruns its bound and runs the next", async () => {
    vi.useFakeTimers();
    const closeInstance = vi.fn(async () => {});

    const shutdown = shutdownServe(
      resources({ mcpRegistry: { stop: never }, closeInstance }),
      BOUNDS,
    );
    await vi.advanceTimersByTimeAsync(BOUNDS.stepMs);
    const outcomes = await shutdown;

    expect(outcomes).toContainEqual({ step: "mcp", outcome: "timed_out", ms: BOUNDS.stepMs });
    expect(outcomes).toContainEqual({ step: "sandbox instance", outcome: "done" });
    expect(closeInstance).toHaveBeenCalledTimes(1);
  });

  it("bounds the web step by its drain plus the step cap", async () => {
    vi.useFakeTimers();

    const shutdown = shutdownServe(resources({ web: { close: never } }), BOUNDS);
    await vi.advanceTimersByTimeAsync(BOUNDS.webDrainMs + BOUNDS.stepMs - 1);
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcomes = await shutdown;

    expect(outcomes[0]).toEqual({
      step: "web server",
      outcome: "timed_out",
      ms: BOUNDS.webDrainMs + BOUNDS.stepMs,
    });
  });

  it("reports a step that throws and runs the next", async () => {
    const failure = new Error("daemon gone");
    const closeInstance = vi.fn(async () => {});

    const outcomes = await shutdownServe(
      resources({ sandbox: { shutdown: vi.fn().mockRejectedValue(failure) }, closeInstance }),
      BOUNDS,
    );

    expect(outcomes).toContainEqual({ step: "sandbox", outcome: "failed", error: failure });
    expect(closeInstance).toHaveBeenCalledTimes(1);
  });

  it("skips the sandbox steps when there is no sandbox", async () => {
    const outcomes = await shutdownServe(resources({ sandbox: null, closeInstance: null }), BOUNDS);

    expect(outcomes.map(({ step }) => step)).toEqual([
      "web server",
      "telegram adapter",
      "coding streams",
      "mcp",
      "skills pool",
    ]);
  });
});
