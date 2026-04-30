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

  it("isolates publisher from a throwing subscriber and still delivers to siblings", () => {
    // Publisher (orchestrator) must not be killed by a subscriber failure
    // — a throwing or rejecting listener (e.g. transient Telegram API
    // error) is logged and dropped; later listeners on the same event
    // still fire.
    const reg = new CodingStreamingRegistry();
    const survivor: string[] = [];
    reg.subscribe("t1", () => {
      throw new Error("boom");
    });
    reg.subscribe("t1", (e) => {
      if (e.kind === "text") survivor.push(e.delta);
    });
    expect(() => reg.publish("t1", { kind: "text", delta: "x" })).not.toThrow();
    expect(survivor).toEqual(["x"]);
  });

  it("isolates publisher from a rejecting async subscriber too", async () => {
    // Subscribers are typically async; an unhandled promise rejection
    // would crash the process under Node's --unhandled-rejections=strict.
    // Registry catches the rejection at the boundary.
    const reg = new CodingStreamingRegistry();
    const survivor: string[] = [];
    reg.subscribe("t1", async () => {
      throw new Error("async boom");
    });
    reg.subscribe("t1", (e) => {
      if (e.kind === "text") survivor.push(e.delta);
    });
    expect(() => reg.publish("t1", { kind: "text", delta: "y" })).not.toThrow();
    // Wait a microtask so the async listener's rejection is observed.
    await new Promise((r) => setImmediate(r));
    expect(survivor).toEqual(["y"]);
  });

  describe("concurrency invariants", () => {
    it("delivers a high-volume burst to multiple subscribers in identical order", () => {
      // Smoke test: under a single-threaded synchronous publisher with
      // multiple subscribers, all subscribers must observe the same event
      // sequence. A regression that introduced async dispatch, listener
      // reordering, or per-subscriber buffering would surface here as
      // diverging arrays.
      const reg = new CodingStreamingRegistry();
      const a: string[] = [];
      const b: string[] = [];
      const c: string[] = [];
      reg.subscribe("t1", (e) => {
        if (e.kind === "text") a.push(e.delta);
      });
      reg.subscribe("t1", (e) => {
        if (e.kind === "text") b.push(e.delta);
      });
      reg.subscribe("t1", (e) => {
        if (e.kind === "text") c.push(e.delta);
      });

      const N = 500;
      for (let i = 0; i < N; i++) {
        reg.publish("t1", { kind: "text", delta: String(i) });
      }

      expect(a).toHaveLength(N);
      expect(a).toEqual(b);
      expect(b).toEqual(c);
      expect(a[0]).toBe("0");
      expect(a.at(-1)).toBe(String(N - 1));
    });

    it("subscribers added during a publish do NOT fire for the current event (listener-set snapshot semantics)", () => {
      // The publisher iterates a snapshot of the listener array (per
      // `state.emitter.listeners(STREAM_EVENT)`). A listener that
      // subscribes a sibling mid-emit must not cause that sibling to
      // fire for the in-flight event — only for subsequent ones. This
      // pins the contract so a refactor to live-iteration would fail
      // here instead of double-delivering text deltas to a brand-new
      // subscriber that just happened to attach at an unlucky moment.
      const reg = new CodingStreamingRegistry();
      const late: CodingStreamEvent[] = [];
      reg.subscribe("t1", (e) => {
        if (e.kind === "text" && e.delta === "first") {
          reg.subscribe("t1", (ev) => late.push(ev));
        }
      });

      reg.publish("t1", { kind: "text", delta: "first" });
      expect(late).toEqual([]); // newly added listener missed the in-flight event

      reg.publish("t1", { kind: "text", delta: "second" });
      expect(late).toEqual([{ kind: "text", delta: "second" }]);
    });

    it("self-unsubscribe inside a listener does not affect the current event's siblings", () => {
      // A subscriber that unsubscribes itself mid-emit completes its own
      // invocation (already in the snapshotted listener array), and
      // every other subscriber on the same event still fires. Future
      // publishes skip the unsubscribed listener.
      const reg = new CodingStreamingRegistry();
      const a: number[] = [];
      const b: number[] = [];
      let unsubscribeA: (() => void) | undefined;
      unsubscribeA = reg.subscribe("t1", (e) => {
        if (e.kind === "text") {
          a.push(Number(e.delta));
          if (e.delta === "1") unsubscribeA?.(); // self-detach after first event
        }
      });
      reg.subscribe("t1", (e) => {
        if (e.kind === "text") b.push(Number(e.delta));
      });

      reg.publish("t1", { kind: "text", delta: "1" });
      reg.publish("t1", { kind: "text", delta: "2" });
      reg.publish("t1", { kind: "text", delta: "3" });

      expect(a).toEqual([1]); // unsubscribed itself after delta=1
      expect(b).toEqual([1, 2, 3]); // sibling unaffected
    });

    it("supports re-entrant publish: a listener that publishes another event delivers to all subscribers without infinite recursion", () => {
      // Use case: the orchestrator's onTextDelta handler publishes a
      // tool_result event in response to an inline pattern match. Node's
      // EventEmitter supports synchronous re-entrancy (the inner emit
      // completes before the outer for-loop advances), so listeners must
      // see the inner event mid-outer-listener.
      const reg = new CodingStreamingRegistry();
      const seen: CodingStreamEvent[] = [];
      let reentered = false;
      reg.subscribe("t1", (e) => {
        seen.push(e);
        if (e.kind === "text" && e.delta === "outer" && !reentered) {
          reentered = true;
          reg.publish("t1", { kind: "tool_call", tool: "Read" });
        }
      });

      reg.publish("t1", { kind: "text", delta: "outer" });

      // Outer event observed first (the listener pushed it before
      // re-entering); inner tool_call observed during the same listener
      // invocation; outer reaches no further listeners (only one).
      expect(seen).toEqual([
        { kind: "text", delta: "outer" },
        { kind: "tool_call", tool: "Read" },
      ]);
      expect(reentered).toBe(true);
    });
  });
});
