import { describe, expect, it } from "vitest";
import { type CodingStreamEvent, CodingStreamingRegistry } from "./streaming-registry.js";

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
      const reg = new CodingStreamingRegistry();
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
      const reg = new CodingStreamingRegistry();
      const seen = collect(reg, "t1");
      const execute = reg.executeStream("t1");

      await execute.started?.();
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
    const reg = new CodingStreamingRegistry();
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
    const reg = new CodingStreamingRegistry();
    collect(reg, "t1");
    const plan = reg.planStream("t1");
    await plan.appendText("missed");

    const late = collect(reg, "t1");
    await plan.appendText("live");

    expect(late).toEqual([{ kind: "text", delta: "live" }]);
  });

  describe("lifecycle", () => {
    it("holds nothing for a task published to with no subscriber", async () => {
      const reg = new CodingStreamingRegistry();
      const plan = reg.planStream("t1");

      await plan.appendText("x".repeat(10_000));
      await plan.finalize("the plan");

      expect(reg.taskIds()).toEqual([]);
    });

    it("holds a subscribed task across the plan gate", async () => {
      const reg = new CodingStreamingRegistry();
      const seen = collect(reg, "t1");

      await reg.planStream("t1").finalize("the plan");
      await reg.executeStream("t1").started?.();

      expect(reg.taskIds()).toEqual(["t1"]);
      expect(seen.map((e) => e.kind)).toEqual(["plan_finalized", "execute_started"]);
    });

    it("releases a task once its stream fails", async () => {
      const reg = new CodingStreamingRegistry();
      const seen = collect(reg, "t1");

      await reg.planStream("t1").fail("claude exit code 2");

      expect(seen).toEqual([{ kind: "failed", reason: "claude exit code 2" }]);
      expect(reg.taskIds()).toEqual([]);
    });

    it("releases a task once execute reports success", async () => {
      const reg = new CodingStreamingRegistry();
      const seen = collect(reg, "t1");

      await reg.executeStream("t1").complete(true);

      expect(seen).toEqual([{ kind: "execute_complete", ok: true }]);
      expect(reg.taskIds()).toEqual([]);
    });

    it("keeps a failed execute's stream open for the failure that follows", async () => {
      const reg = new CodingStreamingRegistry();
      const seen = collect(reg, "t1");
      const execute = reg.executeStream("t1");

      await execute.complete(false);
      expect(reg.taskIds()).toEqual(["t1"]);

      await execute.fail("claude exit code 1");
      expect(seen).toEqual([
        { kind: "execute_complete", ok: false },
        { kind: "failed", reason: "claude exit code 1" },
      ]);
      expect(reg.taskIds()).toEqual([]);
    });

    it("drops a publish after the stream ended instead of re-creating the task", async () => {
      // The verify orchestrator streams its test output after execute has
      // ended the stream; a retried step body publishes again.
      const reg = new CodingStreamingRegistry();
      const seen = collect(reg, "t1");
      const execute = reg.executeStream("t1");
      await execute.complete(true);

      await execute.appendText("verify output");
      await execute.fail("verify failed (exit 1)");

      expect(seen).toEqual([{ kind: "execute_complete", ok: true }]);
      expect(reg.taskIds()).toEqual([]);
    });
  });

  describe("sweep", () => {
    it("releases a task the database reports ended at two consecutive sweeps", async () => {
      const reg = new CodingStreamingRegistry();
      const seen = collect(reg, "t1");

      expect(reg.sweep(new Set(["t1"]))).toBe(0);
      expect(reg.taskIds()).toEqual(["t1"]);

      expect(reg.sweep(new Set(["t1"]))).toBe(1);
      expect(reg.taskIds()).toEqual([]);

      await reg.executeStream("t1").started?.();
      expect(seen).toEqual([]);
    });

    it("leaves the final event in flight after a status write to reach the subscriber", async () => {
      const reg = new CodingStreamingRegistry();
      const seen = collect(reg, "t1");

      reg.sweep(new Set(["t1"]));
      await reg.planStream("t1").fail("claude exit code 2");

      expect(seen).toEqual([{ kind: "failed", reason: "claude exit code 2" }]);
      expect(reg.taskIds()).toEqual([]);
    });

    it("keeps a task the database reports live", () => {
      const reg = new CodingStreamingRegistry();
      collect(reg, "live");
      collect(reg, "ended");

      reg.sweep(new Set(["ended"]));
      reg.sweep(new Set(["ended"]));

      expect(reg.taskIds()).toEqual(["live"]);
    });

    it("ignores a task it doesn't hold", () => {
      const reg = new CodingStreamingRegistry();

      expect(reg.sweep(new Set(["never-subscribed"]))).toBe(0);
      expect(reg.sweep(new Set(["never-subscribed"]))).toBe(0);
      expect(reg.taskIds()).toEqual([]);
    });
  });

  describe("isolation", () => {
    it("a throwing subscriber reaches neither the publisher nor its siblings", async () => {
      const reg = new CodingStreamingRegistry();
      reg.subscribe("t1", () => {
        throw new Error("boom");
      });
      const survivor = collect(reg, "t1");

      await expect(reg.planStream("t1").appendText("x")).resolves.toBeUndefined();
      expect(survivor).toEqual([{ kind: "text", delta: "x" }]);
    });

    it("a rejecting subscriber reaches neither the publisher nor its siblings", async () => {
      // An unhandled rejection fails the run, so the registry must catch it.
      const reg = new CodingStreamingRegistry();
      reg.subscribe("t1", async () => {
        throw new Error("async boom");
      });
      const survivor = collect(reg, "t1");

      await expect(reg.planStream("t1").appendText("y")).resolves.toBeUndefined();
      await new Promise((r) => setImmediate(r));
      expect(survivor).toEqual([{ kind: "text", delta: "y" }]);
    });

    it("a subscriber that never settles holds neither the publisher nor the task", async () => {
      const reg = new CodingStreamingRegistry();
      reg.subscribe("t1", () => new Promise<void>(() => {}));
      const execute = reg.executeStream("t1");

      await execute.appendText("x");
      await execute.fail("boom");

      expect(reg.taskIds()).toEqual([]);
    });
  });

  describe("concurrency invariants", () => {
    it("delivers a high-volume burst to multiple subscribers in identical order", async () => {
      // A regression that introduced async dispatch, listener reordering,
      // or per-subscriber buffering would surface as diverging arrays.
      const reg = new CodingStreamingRegistry();
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
      const reg = new CodingStreamingRegistry();
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

    it("the event that ends a stream reaches every subscriber, though the task is released first", async () => {
      const reg = new CodingStreamingRegistry();
      const heldDuringDelivery: ReadonlyArray<string>[] = [];
      reg.subscribe("t1", () => {
        heldDuringDelivery.push(reg.taskIds());
      });
      const a = collect(reg, "t1");
      const b = collect(reg, "t1");

      await reg.executeStream("t1").fail("boom");

      expect(heldDuringDelivery).toEqual([[]]);
      expect(a).toEqual([{ kind: "failed", reason: "boom" }]);
      expect(b).toEqual([{ kind: "failed", reason: "boom" }]);
    });

    it("supports re-entrant publish: a listener that publishes another event delivers it without infinite recursion", async () => {
      // The inner publish completes before the outer delivery loop advances,
      // so the listener sees the inner event during its own invocation.
      const reg = new CodingStreamingRegistry();
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
