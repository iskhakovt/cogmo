import { InngestTestEngine } from "@inngest/test";
import type { EventPayload } from "inngest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../inngest/client.js";
import { debounceWaitMs } from "../metrics.js";
import { expectDefined } from "../test/assertions.js";
import { spyOnInngestSend } from "../test/factories.js";
import { inngestDurationToMs } from "../test/inngest-duration.js";
import { createDebounceFunctions } from "./debounce.js";

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
  it("records one kind=native debounceWaitMs sample per fire, the trigger event's age", async () => {
    // Driven through the engine, which re-invokes the body at every step
    // boundary as the executor does.
    const recordSpy = vi.spyOn(debounceWaitMs, "record");
    const sendSpy = spyOnInngestSend(inngest).mockResolvedValue({ ids: ["fake"] });
    try {
      const [router] = createDebounceFunctions({
        idleTimeoutMs: 3000,
        maxWaitMs: 30000,
        resumePolicy: "debounce",
      });
      const { result } = await new InngestTestEngine({
        function: expectDefined(router, "router"),
        events: [{ name: "inbound/arrived", data: baseEvent.data, ts: Date.now() - 2500 }],
      }).execute();

      expect(result).toEqual({ mode: "native", triggerInboundId: "inbound-1" });
      expect(recordSpy).toHaveBeenCalledExactlyOnceWith(expect.any(Number), { kind: "native" });
      const [recordedMs] = expectDefined(recordSpy.mock.calls[0], "record call");
      expect(recordedMs).toBeGreaterThanOrEqual(2500);
    } finally {
      recordSpy.mockRestore();
      sendSpy.mockRestore();
    }
  });
});

/**
 * Durable waits have a one-second resolution, which the SDK applies by
 * rewriting a sleep's duration (`durable-sleep.test.ts` pins that upstream
 * parsing). The timers pre-quantise their duration, so the wait the engine
 * performs and the sample they record are the same number. These tests run
 * through the real execution engine rather than a `step` stub, because a stub
 * records whatever string it was handed and so cannot observe the rewrite.
 */
describe("legacy timers — durable sleep floor", () => {
  let sendSpy: ReturnType<typeof spyOnInngestSend>;

  beforeEach(() => {
    sendSpy = spyOnInngestSend(inngest);
    sendSpy.mockResolvedValue({ ids: ["fake"] });
  });

  afterEach(() => {
    sendSpy.mockRestore();
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
    "%s timer records one sample per fire, the wait Inngest performs, not the one requested (%#)",
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
        // emit and the record; the engine has no clock to advance. It re-invokes
        // the body at every step boundary, as the executor does.
        await new InngestTestEngine({ function: timer, events }).execute({
          steps: [{ id: "wait", handler: () => null }],
        });

        expect(recordSpy).toHaveBeenCalledExactlyOnceWith(inngestDurationToMs(sleepDuration), {
          kind,
        });
      } finally {
        recordSpy.mockRestore();
      }
    },
  );
});
