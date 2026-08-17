import { InngestTestEngine } from "@inngest/test";
import type { EventPayload } from "inngest";
import * as R from "remeda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { inngest } from "../inngest/client.js";
import type { inboundArrived } from "../inngest/events.js";
import { debounceWaitMs } from "../metrics.js";
import { expectDefined } from "../test/assertions.js";
import { invokeInngestFn, type MockStep, mockStep, spyOnInngestSend } from "../test/factories.js";
import { createDebounceFunctions, durableSleepMs } from "./debounce.js";

type InboundArrivedData = z.infer<typeof inboundArrived.schema>;

interface DebounceRouterCtx {
  event: { data: InboundArrivedData; ts?: number };
  step: MockStep;
}

const baseEvent = {
  data: { conversationId: "conv-1", inboundMessageId: "inbound-1" },
};

interface DebounceInternalOpts {
  debounce?: { period?: string; timeout?: string; key?: string };
}
function debounceOpts(
  fn: { opts?: DebounceInternalOpts; options?: DebounceInternalOpts } | undefined,
): DebounceInternalOpts | undefined {
  return fn?.opts ?? fn?.options;
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
    await invokeInngestFn<DebounceRouterCtx>(expectDefined(router, "router"), {
      event: baseEvent,
      step,
    });

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
    await invokeInngestFn<DebounceRouterCtx>(expectDefined(router, "router"), {
      event: eventWithTs,
      step,
    });

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
    await invokeInngestFn<DebounceRouterCtx>(expectDefined(router, "router"), {
      event: baseEvent,
      step,
    });

    expect(step.sendEvent).toHaveBeenCalledWith(
      "route",
      expect.arrayContaining([
        expect.objectContaining({ name: "debounce/idle" }),
        expect.objectContaining({ name: "debounce/maxwait" }),
      ]),
    );
    const sendCall = step.sendEvent.mock.calls[0];
    if (!sendCall) throw new Error("expected sendEvent to have been called");
    const events = sendCall[1] as Array<{ name: string }>;
    expect(events.every((e) => e.name !== "inbound/ready")).toBe(true);
  });

  it("emits inbound/ready directly when both timeouts are 0", async () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 0,
      maxWaitMs: 0,
      resumePolicy: "debounce",
    });
    const step = mockStep();
    await invokeInngestFn<DebounceRouterCtx>(expectDefined(router, "router"), {
      event: baseEvent,
      step,
    });

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
    await invokeInngestFn<DebounceRouterCtx>(expectDefined(router, "router"), {
      event: baseEvent,
      step,
    });

    const sendCall = step.sendEvent.mock.calls[0];
    if (!sendCall) throw new Error("expected sendEvent to have been called");
    const events = sendCall[1] as Array<{ name: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe("debounce/maxwait");
  });
});

/**
 * Milliseconds per suffix in the duration strings Inngest emits for a sleep op.
 * Mirrors the SDK's own unit table, which is the whole vocabulary a sleep name
 * can be written in — note the absence of a millisecond unit.
 */
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  w: 7 * 24 * 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000,
};

/**
 * Decode an Inngest duration string (`"3s"`, `"1m30s"`) back to milliseconds.
 *
 * Reads the engine's own output rather than re-deriving it, so an assertion
 * built on this measures the wait the executor was actually asked for instead
 * of restating the mapping the code under test just applied.
 */
function inngestDurationToMs(duration: string): number {
  const parts = [...duration.matchAll(/(\d+)([wdhms])/g)];
  if (R.pipe(parts, R.map(R.prop(0)), R.join("")) !== duration) {
    throw new Error(`unexpected sleep duration string: ${duration}`);
  }
  return R.sumBy(
    parts,
    (part) =>
      Number(expectDefined(part[1], "duration count")) *
      expectDefined(DURATION_UNIT_MS[expectDefined(part[2], "duration unit")], "duration unit ms"),
  );
}

/**
 * Durable waits have a one-second resolution. Inngest parses `step.sleep`'s
 * argument into whole time units, so a positive sub-second duration rounds up
 * to one second and anything longer truncates down to whole seconds. These
 * tests run through the real execution engine rather than a `step` stub,
 * because a stub records whatever string it was handed and so cannot observe
 * that rewrite at all.
 *
 * Two layers, and the order matters. The first suite pins the SDK's parsing of
 * raw durations — the premise {@link durableSleepMs} exists to mirror, and the
 * reason a sub-second idle config is allowed to wait a full second. The second
 * suite pins our own timers, which pre-quantise their duration and so never
 * exercise the rewrite themselves.
 */
describe("inngest step.sleep — duration quantisation (upstream behavior)", () => {
  /**
   * Minimal function whose only op is a sleep of exactly the duration under
   * test. `step.name` on that op is the duration string after the SDK's own
   * parsing, which is the wait the executor will really perform.
   */
  async function engineSleepDuration(requested: string): Promise<string | undefined> {
    const probe = inngest.createFunction(
      { id: "sleep-clamp-probe", triggers: [{ event: "test/sleep-clamp" }] },
      async ({ step }) => {
        await step.sleep("wait", requested);
      },
    );
    const { step } = await new InngestTestEngine({
      function: probe,
      events: [{ name: "test/sleep-clamp" }],
    }).executeStep("wait");
    return step.name;
  }

  it.each([["1ms"], ["500ms"], ["999ms"]])(
    "rounds the raw sub-second duration %s up to 1s",
    async (requested) => {
      expect(await engineSleepDuration(requested)).toBe("1s");
    },
  );

  it("leaves a whole-second duration alone", async () => {
    // Guards the assertion above against passing for the wrong reason — if
    // the engine collapsed every duration to "1s", the clamp cases would
    // still be green.
    expect(await engineSleepDuration("3000ms")).toBe("3s");
  });

  // A duration over one second keeps only whole units, so the sub-second
  // remainder is dropped rather than rounded — there is no millisecond suffix
  // for the SDK to write it into.
  it.each([
    ["1500ms", "1s"],
    ["2500ms", "2s"],
    ["59999ms", "59s"],
    ["90500ms", "1m30s"],
  ])("truncates the requested duration %s to %s", async (requested, expected) => {
    expect(await engineSleepDuration(requested)).toBe(expected);
  });

  /**
   * The invariant the timer handlers rely on: a duration derived from
   * {@link durableSleepMs} survives the SDK's parsing unchanged, so the value
   * recorded on the histogram is the wait the executor was asked for.
   */
  it.each([[1], [500], [999], [1000], [1500], [2500], [3000], [59999], [90500]])(
    "durableSleepMs(%i) round-trips through the engine unchanged",
    async (requested) => {
      const ms = durableSleepMs(requested);
      const duration = expectDefined(await engineSleepDuration(`${ms}ms`), "sleep duration");
      expect(inngestDurationToMs(duration)).toBe(ms);
    },
  );
});

describe("legacy timers — durable sleep floor", () => {
  let sendSpy: ReturnType<typeof spyOnInngestSend>;

  beforeEach(() => {
    sendSpy = spyOnInngestSend(inngest);
    sendSpy.mockResolvedValue({ ids: ["fake"] });
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  it.each([
    [0, 0],
    [1, 1000],
    [500, 1000],
    [999, 1000],
    [1000, 1000],
    [1500, 1000],
    [2500, 2000],
    [3000, 3000],
    [59999, 59000],
    [90500, 90000],
  ])("durableSleepMs(%i) is %i", (requested, expected) => {
    expect(durableSleepMs(requested)).toBe(expected);
  });

  // Columns: histogram kind, index into `createDebounceFunctions`' legacy
  // `[router, idle, maxwait]` tuple, config, trigger event name, that event's
  // `timeoutMs`, and the duration string Inngest ends up handing the executor.
  it.each([
    ["idle" as const, 1, { idleTimeoutMs: 500, maxWaitMs: 5000 }, "debounce/idle", 500, "1s"],
    ["maxwait" as const, 2, { idleTimeoutMs: 3000, maxWaitMs: 500 }, "debounce/maxwait", 500, "1s"],
    ["idle" as const, 1, { idleTimeoutMs: 3000, maxWaitMs: 500 }, "debounce/idle", 3000, "3s"],
    ["idle" as const, 1, { idleTimeoutMs: 2500, maxWaitMs: 500 }, "debounce/idle", 2500, "2s"],
    [
      "maxwait" as const,
      2,
      { idleTimeoutMs: 0, maxWaitMs: 30500 },
      "debounce/maxwait",
      30500,
      "30s",
    ],
    [
      "maxwait" as const,
      2,
      { idleTimeoutMs: 0, maxWaitMs: 90500 },
      "debounce/maxwait",
      90500,
      "1m30s",
    ],
  ])(
    "%s timer records the wait Inngest performs, not the one requested (%#)",
    async (kind, fnIndex, config, eventName, timeoutMs, expectedDuration) => {
      const recordSpy = vi.spyOn(debounceWaitMs, "record");
      try {
        const fns = createDebounceFunctions({ ...config, resumePolicy: "debounce" });
        const timer = expectDefined(fns[fnIndex], `${kind} timer`);
        const events: [EventPayload, ...EventPayload[]] = [
          {
            name: eventName,
            data: { conversationId: "conv-1", inboundMessageId: "inbound-1", timeoutMs },
          },
        ];

        // `step.name` on the sleep op is the duration string after Inngest's
        // own parsing — the wait the executor will really perform.
        const { step } = await new InngestTestEngine({ function: timer, events }).executeStep(
          "wait",
        );
        const sleepDuration = expectDefined(step.name, "sleep duration");
        expect(sleepDuration).toBe(expectedDuration);

        // Memoize the sleep as already elapsed so the run continues into the
        // record + emit tail; the engine has no clock to advance.
        await new InngestTestEngine({ function: timer, events }).execute({
          steps: [{ id: "wait", handler: () => null }],
        });

        expect(recordSpy).toHaveBeenCalledWith(inngestDurationToMs(sleepDuration), { kind });
      } finally {
        recordSpy.mockRestore();
      }
    },
  );
});
