import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { expectDefined } from "../../test/assertions.js";
import { type CodingStreamEvent, CodingStreamingRegistry } from "./streaming-registry.js";

const SWEEP_INTERVAL_MS = 60_000;

type EndedTasks = (taskIds: ReadonlyArray<string>) => Promise<ReadonlySet<string>>;

const open: CodingStreamingRegistry[] = [];

afterEach(() => {
  for (const reg of open.splice(0)) reg.close();
  vi.useRealTimers();
});

/** A registry on its default timer, for tests that don't sweep. */
function registry(endedTasks: EndedTasks = async () => new Set()): CodingStreamingRegistry {
  const reg = CodingStreamingRegistry.create({ endedTasks, sweepIntervalMs: SWEEP_INTERVAL_MS });
  open.push(reg);
  return reg;
}

interface Harness {
  reg: CodingStreamingRegistry;
  /** The database lookup the registry sweeps with. Reports nothing ended unless a test says so. */
  endedTasks: Mock<EndedTasks>;
  /** Run one sweep, as the registry's timer would. */
  sweep: () => Promise<void>;
}

/** A registry whose sweeps the test runs. */
function harness(): Harness {
  const endedTasks = vi.fn<EndedTasks>(async () => new Set());
  let tick: (() => Promise<void>) | undefined;
  const reg = CodingStreamingRegistry.create({
    endedTasks,
    sweepIntervalMs: SWEEP_INTERVAL_MS,
    setInterval: (cb) => {
      tick = cb;
      return "timer";
    },
    clearInterval: () => {},
  });
  return { reg, endedTasks, sweep: () => expectDefined(tick, "sweep timer")() };
}

/**
 * The tasks the registry holds: what a sweep asks the database about. The
 * probe's sweep reports nothing ended, so it releases nothing, and it starts
 * every held task's count again.
 */
async function held(h: Harness): Promise<ReadonlyArray<string>> {
  h.endedTasks.mockClear();
  h.endedTasks.mockResolvedValueOnce(new Set());
  await h.sweep();
  return h.endedTasks.mock.calls[0]?.[0] ?? [];
}

function collect(reg: CodingStreamingRegistry, taskId: string): CodingStreamEvent[] {
  const seen: CodingStreamEvent[] = [];
  reg.subscribe(taskId, (e) => {
    seen.push(e);
  });
  return seen;
}

describe("CodingStreamingRegistry", () => {
  describe("handles", () => {
    it("the plan handle publishes text, the finalized plan and a failure", async () => {
      const reg = registry();
      const seen = collect(reg, "t1");
      const plan = reg.planStream("t1");

      await plan.appendText("## Plan\n");
      await plan.finalize("## Plan\nbody");
      await plan.finalize("## Plan\nbody", { autoApproved: true });
      await plan.fail("boom");

      expect(seen).toEqual([
        { kind: "text", delta: "## Plan\n" },
        { kind: "plan_finalized", plan: "## Plan\nbody" },
        { kind: "plan_finalized", plan: "## Plan\nbody", autoApproved: true },
        { kind: "failed", reason: "boom" },
      ]);
    });

    it("the execute handle publishes progress, then completion", async () => {
      const reg = registry();
      const seen = collect(reg, "t1");
      const execute = reg.executeStream("t1");

      await execute.started();
      await execute.appendText("editing");
      await execute.toolCall("Edit");
      await execute.toolResult("Edit", true);
      await execute.toolResult("Edit", false, "no such file");
      await execute.complete(true, { input: 10, output: 5 });

      expect(seen).toEqual([
        { kind: "execute_started" },
        { kind: "text", delta: "editing" },
        { kind: "tool_call", tool: "Edit" },
        { kind: "tool_result", tool: "Edit", ok: true },
        { kind: "tool_result", tool: "Edit", ok: false, summary: "no such file" },
        { kind: "execute_complete", ok: true, tokens: { input: 10, output: 5 } },
      ]);
    });
  });

  it("delivers events to every subscriber of the task, in publish order", async () => {
    const reg = registry();
    const a = collect(reg, "t1");
    const b = collect(reg, "t1");
    const other = collect(reg, "t2");
    const plan = reg.planStream("t1");

    await plan.appendText("hello ");
    await plan.appendText("world");

    const expected = [
      { kind: "text", delta: "hello " },
      { kind: "text", delta: "world" },
    ];
    expect(a).toEqual(expected);
    expect(b).toEqual(expected);
    expect(other).toEqual([]);
  });

  it("does not replay events published before a subscriber arrived", async () => {
    const reg = registry();
    collect(reg, "t1");
    const plan = reg.planStream("t1");
    await plan.appendText("missed");

    const late = collect(reg, "t1");
    await plan.appendText("live");

    expect(late).toEqual([{ kind: "text", delta: "live" }]);
  });

  describe("lifecycle", () => {
    it("holds nothing for a task published to with no subscriber", async () => {
      const h = harness();
      const plan = h.reg.planStream("t1");

      await plan.appendText("x".repeat(10_000));
      await plan.finalize("the plan");

      expect(await held(h)).toEqual([]);
      expect(h.endedTasks).not.toHaveBeenCalled();
    });

    it("holds a subscribed task across the plan gate", async () => {
      const h = harness();
      const seen = collect(h.reg, "t1");

      await h.reg.planStream("t1").finalize("the plan");
      await h.reg.executeStream("t1").started();

      expect(await held(h)).toEqual(["t1"]);
      expect(seen.map((e) => e.kind)).toEqual(["plan_finalized", "execute_started"]);
    });

    it("releases a task once its stream fails", async () => {
      const h = harness();
      const seen = collect(h.reg, "t1");

      await h.reg.planStream("t1").fail("claude exit code 2");

      expect(seen).toEqual([{ kind: "failed", reason: "claude exit code 2" }]);
      expect(await held(h)).toEqual([]);
    });

    it("releases a task once execute reports success", async () => {
      const h = harness();
      const seen = collect(h.reg, "t1");

      await h.reg.executeStream("t1").complete(true);

      expect(seen).toEqual([{ kind: "execute_complete", ok: true }]);
      expect(await held(h)).toEqual([]);
    });

    it("keeps a failed execute's stream open for the failure that follows", async () => {
      const h = harness();
      const seen = collect(h.reg, "t1");
      const execute = h.reg.executeStream("t1");

      await execute.complete(false);
      expect(await held(h)).toEqual(["t1"]);

      await execute.fail("claude exit code 1");
      expect(seen).toEqual([
        { kind: "execute_complete", ok: false },
        { kind: "failed", reason: "claude exit code 1" },
      ]);
      expect(await held(h)).toEqual([]);
    });

    it("drops a publish after the stream ended instead of re-creating the task", async () => {
      // A retried step body publishes again after the stream has ended.
      const h = harness();
      const seen = collect(h.reg, "t1");
      const execute = h.reg.executeStream("t1");
      await execute.complete(true);

      await execute.appendText("late narration");
      await execute.fail("late failure");

      expect(seen).toEqual([{ kind: "execute_complete", ok: true }]);
      expect(await held(h)).toEqual([]);
    });
  });

  describe("sweep", () => {
    it("releases a task the database reports ended at two consecutive sweeps", async () => {
      const h = harness();
      const seen = collect(h.reg, "t1");
      h.endedTasks.mockResolvedValue(new Set(["t1"]));

      await h.sweep();
      expect(h.endedTasks).toHaveBeenLastCalledWith(["t1"]);
      await h.sweep();
      expect(h.endedTasks).toHaveBeenCalledTimes(2);

      await h.sweep();
      expect(h.endedTasks).toHaveBeenCalledTimes(2);
      await h.reg.executeStream("t1").started();
      expect(seen).toEqual([]);
    });

    it("starts the count again when a sweep finds the task live", async () => {
      // A terminal status can be overwritten: execute's `pending_verify`
      // write is unconditional, so it can land over a `cancelled`.
      const h = harness();
      collect(h.reg, "t1");
      h.endedTasks
        .mockResolvedValueOnce(new Set(["t1"]))
        .mockResolvedValueOnce(new Set())
        .mockResolvedValueOnce(new Set(["t1"]))
        .mockResolvedValueOnce(new Set(["t1"]));

      await h.sweep();
      await h.sweep();
      await h.sweep();
      await h.sweep();
      expect(h.endedTasks).toHaveBeenCalledTimes(4);

      await h.sweep();
      expect(h.endedTasks).toHaveBeenCalledTimes(4);
    });

    it("leaves the final event in flight after a status write to reach the subscriber", async () => {
      const h = harness();
      const seen = collect(h.reg, "t1");
      h.endedTasks.mockResolvedValue(new Set(["t1"]));

      await h.sweep();
      await h.reg.planStream("t1").fail("claude exit code 2");

      expect(seen).toEqual([{ kind: "failed", reason: "claude exit code 2" }]);
      expect(await held(h)).toEqual([]);
    });

    it("keeps a task the database reports live", async () => {
      const h = harness();
      collect(h.reg, "live");
      collect(h.reg, "ended");
      h.endedTasks.mockResolvedValue(new Set(["ended"]));

      await h.sweep();
      await h.sweep();

      expect(await held(h)).toEqual(["live"]);
    });

    it("a failed sweep releases nothing and keeps the count, and the next one asks again", async () => {
      const h = harness();
      collect(h.reg, "t1");
      h.endedTasks.mockResolvedValue(new Set(["t1"]));

      await h.sweep();
      h.endedTasks.mockRejectedValueOnce(new Error("connection reset"));
      await expect(h.sweep()).resolves.toBeUndefined();
      expect(h.endedTasks).toHaveBeenCalledTimes(2);

      await h.sweep();
      expect(await held(h)).toEqual([]);
    });

    it("runs one sweep at a time, so a stalled lookup doesn't cut the grace short", async () => {
      const h = harness();
      collect(h.reg, "t1");
      const stalled = Promise.withResolvers<ReadonlySet<string>>();
      h.endedTasks.mockReturnValueOnce(stalled.promise);
      h.endedTasks.mockResolvedValue(new Set(["t1"]));

      const first = h.sweep();
      await h.sweep();
      expect(h.endedTasks).toHaveBeenCalledTimes(1);

      stalled.resolve(new Set(["t1"]));
      await first;
      await h.sweep();
      expect(h.endedTasks).toHaveBeenCalledTimes(2);
      expect(await held(h)).toEqual([]);
    });

    it("skips a task its own event released while the lookup ran", async () => {
      const h = harness();
      const seen = collect(h.reg, "t1");
      const lookup = Promise.withResolvers<ReadonlySet<string>>();
      h.endedTasks.mockReturnValueOnce(lookup.promise);

      const sweeping = h.sweep();
      await h.reg.planStream("t1").fail("claude exit code 2");
      lookup.resolve(new Set(["t1"]));

      await expect(sweeping).resolves.toBeUndefined();
      expect(seen).toEqual([{ kind: "failed", reason: "claude exit code 2" }]);
      expect(await held(h)).toEqual([]);
    });

    describe("on its own timer", () => {
      it("sweeps every interval until closed, and carries on after a failed sweep", async () => {
        vi.useFakeTimers();
        const endedTasks = vi.fn<EndedTasks>(async () => new Set());
        endedTasks.mockRejectedValueOnce(new Error("connection reset"));
        const reg = registry(endedTasks);
        collect(reg, "t1");

        await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS - 1);
        expect(endedTasks).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2 * SWEEP_INTERVAL_MS);
        expect(endedTasks).toHaveBeenCalledTimes(2);

        reg.close();
        await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
        expect(endedTasks).toHaveBeenCalledTimes(2);
      });

      it("never keeps the process alive", () => {
        const timeouts = (): number =>
          process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
        const before = timeouts();
        const control = setInterval(() => {}, SWEEP_INTERVAL_MS);
        expect(timeouts()).toBe(before + 1);
        clearInterval(control);

        registry();

        expect(timeouts()).toBe(before);
      });

      it("close clears the timer once", () => {
        const clear = vi.fn();
        const reg = CodingStreamingRegistry.create({
          endedTasks: async () => new Set(),
          sweepIntervalMs: SWEEP_INTERVAL_MS,
          setInterval: () => "timer",
          clearInterval: clear,
        });

        reg.close();
        reg.close();

        expect(clear).toHaveBeenCalledTimes(1);
        expect(clear).toHaveBeenCalledWith("timer");
      });
    });
  });

  describe("isolation", () => {
    it("a throwing subscriber reaches neither the publisher nor its siblings", async () => {
      const reg = registry();
      reg.subscribe("t1", () => {
        throw new Error("boom");
      });
      const survivor = collect(reg, "t1");

      await expect(reg.planStream("t1").appendText("x")).resolves.toBeUndefined();
      expect(survivor).toEqual([{ kind: "text", delta: "x" }]);
    });

    it("a rejecting subscriber reaches neither the publisher nor its siblings", async () => {
      // An unhandled rejection fails the run, so the registry must catch it.
      const reg = registry();
      reg.subscribe("t1", async () => {
        throw new Error("async boom");
      });
      const survivor = collect(reg, "t1");

      await expect(reg.planStream("t1").appendText("y")).resolves.toBeUndefined();
      await new Promise((r) => setImmediate(r));
      expect(survivor).toEqual([{ kind: "text", delta: "y" }]);
    });

    it("a subscriber that never settles holds neither the publisher nor the task", async () => {
      const h = harness();
      h.reg.subscribe("t1", () => new Promise<void>(() => {}));
      const execute = h.reg.executeStream("t1");

      await execute.appendText("x");
      await execute.fail("boom");

      expect(await held(h)).toEqual([]);
    });
  });

  describe("concurrency invariants", () => {
    it("delivers a high-volume burst to multiple subscribers in identical order", async () => {
      // A regression that introduced async dispatch, listener reordering,
      // or per-subscriber buffering would surface as diverging arrays.
      const reg = registry();
      const a = collect(reg, "t1");
      const b = collect(reg, "t1");
      const c = collect(reg, "t1");
      const execute = reg.executeStream("t1");

      const N = 500;
      for (let i = 0; i < N; i++) {
        await execute.appendText(String(i));
      }

      expect(a).toHaveLength(N);
      expect(a).toEqual(b);
      expect(b).toEqual(c);
      expect(a[0]).toEqual({ kind: "text", delta: "0" });
      expect(a.at(-1)).toEqual({ kind: "text", delta: String(N - 1) });
    });

    it("subscribers added during a publish do NOT fire for the current event (listener-set snapshot semantics)", async () => {
      // A listener that subscribes a sibling mid-emit must not cause that
      // sibling to fire for the in-flight event — only for later ones.
      const reg = registry();
      const late: CodingStreamEvent[] = [];
      reg.subscribe("t1", (e) => {
        if (e.kind === "text" && e.delta === "first") {
          reg.subscribe("t1", (ev) => {
            late.push(ev);
          });
        }
      });
      const plan = reg.planStream("t1");

      await plan.appendText("first");
      expect(late).toEqual([]);

      await plan.appendText("second");
      expect(late).toEqual([{ kind: "text", delta: "second" }]);
    });

    it("the event that ends a stream reaches every subscriber, and nothing published during its delivery follows it", async () => {
      // The task is released before delivery, so a publish from inside a
      // listener is dropped.
      const reg = registry();
      reg.subscribe("t1", () => {
        void reg.executeStream("t1").appendText("after the end");
      });
      const a = collect(reg, "t1");
      const b = collect(reg, "t1");

      await reg.executeStream("t1").fail("boom");

      expect(a).toEqual([{ kind: "failed", reason: "boom" }]);
      expect(b).toEqual([{ kind: "failed", reason: "boom" }]);
    });

    it("supports re-entrant publish: a listener that publishes another event delivers it without infinite recursion", async () => {
      // The inner publish completes before the outer delivery loop advances,
      // so the listener sees the inner event during its own invocation.
      const reg = registry();
      const seen: CodingStreamEvent[] = [];
      const execute = reg.executeStream("t1");
      let reentered = false;
      reg.subscribe("t1", (e) => {
        seen.push(e);
        if (e.kind === "text" && e.delta === "outer" && !reentered) {
          reentered = true;
          void execute.toolCall("Read");
        }
      });

      await execute.appendText("outer");

      expect(seen).toEqual([
        { kind: "text", delta: "outer" },
        { kind: "tool_call", tool: "Read" },
      ]);
    });
  });
});
