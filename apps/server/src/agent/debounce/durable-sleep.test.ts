import { InngestTestEngine } from "@inngest/test";
import { describe, expect, it } from "vitest";
import { inngest } from "../../inngest/client.js";
import { expectDefined } from "../../test/assertions.js";
import { inngestDurationToMs } from "../../test/inngest-duration.js";
import { durableSleepMs } from "./durable-sleep.js";

describe("durableSleepMs", () => {
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
});

/**
 * Durable waits have a one-second resolution. Inngest parses `step.sleep`'s
 * argument into whole time units, so a positive sub-second duration rounds up
 * to one second and anything longer truncates down to whole seconds. These
 * tests run through the real execution engine rather than a `step` stub,
 * because a stub records whatever string it was handed and so cannot observe
 * that rewrite at all.
 *
 * They pin the SDK's parsing of raw durations — the premise
 * {@link durableSleepMs} exists to mirror, and the reason a sub-second idle
 * config is allowed to wait a full second. The debounce timers' own suite
 * (`debounce.test.ts`) pins that they pre-quantise and so never exercise the
 * rewrite themselves.
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
