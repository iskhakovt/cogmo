import { describe, expect, it, vi } from "vitest";
import { createDebounceFunctions } from "./debounce.js";

const baseEvent = {
  data: { conversationId: "conv-1", inboundMessageId: "inbound-1" },
};

// biome-ignore lint/suspicious/noExplicitAny: Inngest function opts aren't part of the public TS surface
function debounceOpts(fn: any): any {
  return fn?.opts ?? fn?.options;
}

function mockStep() {
  return { sendEvent: vi.fn(), run: vi.fn((_, fn) => fn()) };
}

describe("createDebounceFunctions — path selection", () => {
  it("native path returns one function (router only)", () => {
    const fns = createDebounceFunctions({
      idleTimeoutMs: 3000,
      maxWaitMs: 30000,
      resumePolicy: "debounce",
    });
    expect(fns).toHaveLength(1);
  });

  it("legacy path returns three functions (router + idle + maxwait)", () => {
    const fns = createDebounceFunctions({
      idleTimeoutMs: 500, // sub-second forces legacy
      maxWaitMs: 5000,
      resumePolicy: "debounce",
    });
    expect(fns).toHaveLength(3);
  });

  it("native path qualifies when idle >= 1s and maxwait is 0 (idle-only)", () => {
    const fns = createDebounceFunctions({
      idleTimeoutMs: 3000,
      maxWaitMs: 0,
      resumePolicy: "debounce",
    });
    expect(fns).toHaveLength(1);
  });
});

describe("native fast-path eligibility (boundaries)", () => {
  it("idle exactly at 1000ms qualifies for native (>=1s threshold)", () => {
    const fns = createDebounceFunctions({
      idleTimeoutMs: 1000,
      maxWaitMs: 30000,
      resumePolicy: "debounce",
    });
    expect(fns).toHaveLength(1);
  });

  it("idle at 999ms falls back to legacy (sub-second)", () => {
    const fns = createDebounceFunctions({
      idleTimeoutMs: 999,
      maxWaitMs: 30000,
      resumePolicy: "debounce",
    });
    expect(fns).toHaveLength(3);
  });

  it("maxwait between 1ms and 999ms forces legacy (sub-second timeout)", () => {
    // Inngest native debounce timeout shares the 1s minimum with period.
    // A non-zero sub-second maxwait can't be expressed natively, so the
    // whole config falls back to legacy.
    const fns = createDebounceFunctions({
      idleTimeoutMs: 3000,
      maxWaitMs: 500,
      resumePolicy: "debounce",
    });
    expect(fns).toHaveLength(3);
  });

  it("idle=0 always forces legacy regardless of maxwait", () => {
    // idle=0 means "no idle reset" — native debounce can't express this
    // because period is required. Pure-throttle (maxwait-only) stays legacy.
    const fns = createDebounceFunctions({
      idleTimeoutMs: 0,
      maxWaitMs: 30000,
      resumePolicy: "debounce",
    });
    expect(fns).toHaveLength(3);
  });
});

describe("native router — config shape", () => {
  it("carries Inngest native debounce config keyed on conversationId", () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 3000,
      maxWaitMs: 30000,
      resumePolicy: "debounce",
    });
    expect(debounceOpts(router)?.debounce).toEqual({
      period: "3s",
      timeout: "30s",
      key: "event.data.conversationId",
    });
  });

  it("omits timeout when maxWaitMs is 0", () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 3000,
      maxWaitMs: 0,
      resumePolicy: "debounce",
    });
    const debounce = debounceOpts(router)?.debounce;
    expect(debounce?.timeout).toBeUndefined();
    expect(debounce?.period).toBe("3s");
  });

  it("floors fractional seconds — 3500ms idle becomes 3s period", () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 3500,
      maxWaitMs: 30000,
      resumePolicy: "debounce",
    });
    expect(debounceOpts(router)?.debounce?.period).toBe("3s");
  });
});

describe("native router — handler behavior", () => {
  it("emits exactly one inbound/ready with the trigger inboundMessageId", async () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 3000,
      maxWaitMs: 30000,
      resumePolicy: "debounce",
    });
    const step = mockStep();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into Inngest's internal handler
    await (router as any).fn({ event: baseEvent, step });

    expect(step.sendEvent).toHaveBeenCalledTimes(1);
    expect(step.sendEvent).toHaveBeenCalledWith(
      "ready",
      expect.objectContaining({
        name: "inbound/ready",
        data: { conversationId: "conv-1", triggerInboundId: "inbound-1" },
      }),
    );
  });

  it("records a debounceWaitMs sample with kind=native when event.ts is present", async () => {
    const { debounceWaitMs } = await import("../metrics.js");
    const recordSpy = vi.spyOn(debounceWaitMs, "record");

    const [router] = createDebounceFunctions({
      idleTimeoutMs: 3000,
      maxWaitMs: 30000,
      resumePolicy: "debounce",
    });
    const step = mockStep();
    const eventWithTs = {
      ...baseEvent,
      ts: Date.now() - 2500, // pretend the trigger event was created 2.5s ago
    };
    // biome-ignore lint/suspicious/noExplicitAny: reaching into Inngest's internal handler
    await (router as any).fn({ event: eventWithTs, step });

    expect(recordSpy).toHaveBeenCalledWith(expect.any(Number), { kind: "native" });
    const recordedMs = recordSpy.mock.calls[0]?.[0] as number;
    // Sampled wall-clock gap should be at least the synthetic 2.5s offset.
    expect(recordedMs).toBeGreaterThanOrEqual(2500);

    recordSpy.mockRestore();
  });
});

describe("legacy router — handler behavior", () => {
  it("emits debounce/idle and debounce/maxwait when both configured (sub-second forces legacy)", async () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 500,
      maxWaitMs: 5000,
      resumePolicy: "debounce",
    });
    const step = mockStep();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into Inngest's internal handler
    await (router as any).fn({ event: baseEvent, step });

    expect(step.sendEvent).toHaveBeenCalledWith(
      "route",
      expect.arrayContaining([
        expect.objectContaining({ name: "debounce/idle" }),
        expect.objectContaining({ name: "debounce/maxwait" }),
      ]),
    );
    const events = step.sendEvent.mock.calls[0][1];
    expect(events.every((e) => e.name !== "inbound/ready")).toBe(true);
  });

  it("emits inbound/ready directly when both timeouts are 0", async () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 0,
      maxWaitMs: 0,
      resumePolicy: "debounce",
    });
    const step = mockStep();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into Inngest's internal handler
    await (router as any).fn({ event: baseEvent, step });

    expect(step.sendEvent).toHaveBeenCalledWith(
      "route",
      expect.arrayContaining([expect.objectContaining({ name: "inbound/ready" })]),
    );
  });

  it("emits only debounce/maxwait when idle is 0 (maxwait-only)", async () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 0,
      maxWaitMs: 30000,
      resumePolicy: "debounce",
    });
    const step = mockStep();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into Inngest's internal handler
    await (router as any).fn({ event: baseEvent, step });

    const events = step.sendEvent.mock.calls[0][1];
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("debounce/maxwait");
  });
});
