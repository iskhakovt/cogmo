import { describe, expect, it, vi } from "vitest";
import {
  type CodingStreamEvent,
  CodingStreamingRegistry,
  type ProgressMessageRef,
} from "./streaming-registry.js";

const REF: ProgressMessageRef = {
  channelId: "ch-1",
  chatId: "chat-1",
  messageId: "msg-1",
};

describe("CodingStreamingRegistry", () => {
  it("delivers events to subscribers in publish order", () => {
    const reg = new CodingStreamingRegistry();
    const seen: CodingStreamEvent[] = [];
    reg.subscribe("t1", (e) => seen.push(e));

    reg.publish("t1", { kind: "text", delta: "hello " });
    reg.publish("t1", { kind: "text", delta: "world" });
    reg.publish("t1", { kind: "tool_call", tool: "Read" });

    expect(seen).toEqual([
      { kind: "text", delta: "hello " },
      { kind: "text", delta: "world" },
      { kind: "tool_call", tool: "Read" },
    ]);
  });

  it("accumulates text deltas into the snapshot", () => {
    const reg = new CodingStreamingRegistry();
    reg.publish("t1", { kind: "text", delta: "## Plan\n" });
    reg.publish("t1", { kind: "text", delta: "1. Step\n" });

    const snap = reg.getSnapshot("t1");
    expect(snap?.accumulatedText).toBe("## Plan\n1. Step\n");
  });

  it("plan_finalized replaces the accumulated text", () => {
    // The streamed deltas may be incomplete (e.g. the CLI emits the canonical
    // plan body in the result event after the deltas); plan_finalized is
    // authoritative.
    const reg = new CodingStreamingRegistry();
    reg.publish("t1", { kind: "text", delta: "draft" });
    reg.publish("t1", { kind: "plan_finalized", plan: "## Final\nbody" });

    expect(reg.getSnapshot("t1")?.accumulatedText).toBe("## Final\nbody");
  });

  it("late subscribers do NOT replay missed events but DO see the buffered text via snapshot", () => {
    const reg = new CodingStreamingRegistry();
    reg.publish("t1", { kind: "text", delta: "missed" });

    const seen: CodingStreamEvent[] = [];
    reg.subscribe("t1", (e) => seen.push(e));
    expect(seen).toEqual([]);
    expect(reg.getSnapshot("t1")?.accumulatedText).toBe("missed");

    reg.publish("t1", { kind: "text", delta: "+live" });
    expect(seen).toEqual([{ kind: "text", delta: "+live" }]);
    expect(reg.getSnapshot("t1")?.accumulatedText).toBe("missed+live");
  });

  it("supports multiple subscribers on the same task", () => {
    const reg = new CodingStreamingRegistry();
    const a: CodingStreamEvent[] = [];
    const b: CodingStreamEvent[] = [];
    reg.subscribe("t1", (e) => a.push(e));
    reg.subscribe("t1", (e) => b.push(e));

    reg.publish("t1", { kind: "tool_result", tool: "Read", ok: true });

    expect(a).toEqual([{ kind: "tool_result", tool: "Read", ok: true }]);
    expect(b).toEqual([{ kind: "tool_result", tool: "Read", ok: true }]);
  });

  it("scopes subscribers and snapshots by taskId", () => {
    const reg = new CodingStreamingRegistry();
    const seen: CodingStreamEvent[] = [];
    reg.subscribe("t1", (e) => seen.push(e));

    reg.publish("t2", { kind: "text", delta: "for-t2" });

    expect(seen).toEqual([]);
    expect(reg.getSnapshot("t1")?.accumulatedText).toBe("");
    expect(reg.getSnapshot("t2")?.accumulatedText).toBe("for-t2");
  });

  it("unsubscribe stops further deliveries", () => {
    const reg = new CodingStreamingRegistry();
    const seen: CodingStreamEvent[] = [];
    const unsubscribe = reg.subscribe("t1", (e) => seen.push(e));

    reg.publish("t1", { kind: "text", delta: "1" });
    unsubscribe();
    reg.publish("t1", { kind: "text", delta: "2" });

    expect(seen).toEqual([{ kind: "text", delta: "1" }]);
    expect(reg.getSnapshot("t1")?.accumulatedText).toBe("12");
  });

  it("setProgressMessageRef stores a defensive copy and reads via snapshot", () => {
    const reg = new CodingStreamingRegistry();
    const ref = { ...REF };
    reg.setProgressMessageRef("t1", ref);
    ref.messageId = "mutated";

    const snap = reg.getSnapshot("t1");
    expect(snap?.progressMessageRef).toEqual(REF);
  });

  it("dispose clears state and detaches subscribers", () => {
    const reg = new CodingStreamingRegistry();
    const listener = vi.fn();
    reg.subscribe("t1", listener);
    reg.publish("t1", { kind: "text", delta: "x" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reg.size()).toBe(1);

    reg.dispose("t1");
    expect(reg.getSnapshot("t1")).toBeNull();
    expect(reg.size()).toBe(0);

    // Re-publishing creates fresh state; the prior listener is gone.
    reg.publish("t1", { kind: "text", delta: "y" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reg.getSnapshot("t1")?.accumulatedText).toBe("y");
  });

  it("dispose is idempotent", () => {
    const reg = new CodingStreamingRegistry();
    reg.publish("t1", { kind: "text", delta: "x" });
    reg.dispose("t1");
    expect(() => reg.dispose("t1")).not.toThrow();
    expect(reg.size()).toBe(0);
  });

  it("snapshot returns null for unknown taskId", () => {
    const reg = new CodingStreamingRegistry();
    expect(reg.getSnapshot("never")).toBeNull();
  });

  it("getSnapshot returns a defensive copy of progressMessageRef", () => {
    const reg = new CodingStreamingRegistry();
    reg.setProgressMessageRef("t1", REF);
    const snap = reg.getSnapshot("t1");
    if (snap?.progressMessageRef) {
      snap.progressMessageRef.messageId = "mutated-by-consumer";
    }
    expect(reg.getSnapshot("t1")?.progressMessageRef?.messageId).toBe(REF.messageId);
  });

  it("listener exception in one subscriber does not block others", () => {
    // Node's EventEmitter throws synchronously on listener errors; assert the
    // contract so we don't accidentally swallow them later.
    const reg = new CodingStreamingRegistry();
    reg.subscribe("t1", () => {
      throw new Error("boom");
    });
    expect(() => reg.publish("t1", { kind: "text", delta: "x" })).toThrow(/boom/);
  });
});
