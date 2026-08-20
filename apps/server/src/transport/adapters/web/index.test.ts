import { describe, expect, it } from "vitest";
import { WebUiAdapter } from "./index.js";
import type { SseFrame } from "./stream-registry.js";
import { WebStreamRegistry } from "./stream-registry.js";

function setup() {
  const registry = new WebStreamRegistry();
  const adapter = new WebUiAdapter(registry);
  /** Connect a tab and return the list its frames land in. */
  const connect = (address: string): SseFrame[] => {
    const frames: SseFrame[] = [];
    registry.register(address, { send: (f) => frames.push(f) });
    return frames;
  };
  return { registry, adapter, connect };
}

describe("WebUiAdapter", () => {
  it("pushes stream events as default SSE frames to the tab's connection", async () => {
    const { adapter, connect } = setup();
    const frames = connect("tab-1");
    const handle = await adapter.openStream("tab-1", "run-1");
    await handle.push({ type: "text_delta", text: "hi" });
    await handle.push({ type: "status", message: "thinking" });
    expect(frames).toEqual([
      { data: JSON.stringify({ type: "text_delta", text: "hi" }) },
      { data: JSON.stringify({ type: "status", message: "thinking" }) },
    ]);
  });

  it("emits named lifecycle frames on finish and abort", async () => {
    const { adapter, connect } = setup();
    const frames = connect("tab-1");
    const streamed = await adapter.openStream("tab-1", "run-1");
    await streamed.push({ type: "text_delta", text: "hi" });
    await streamed.finish();
    await (await adapter.openStream("tab-1", "run-2")).abort("boom");
    expect(frames).toEqual([
      { data: JSON.stringify({ type: "text_delta", text: "hi" }) },
      { event: "turn-end", data: "{}" },
      { event: "turn-abort", data: JSON.stringify({ message: "boom" }) },
    ]);
  });

  it("suppresses turn-end from a handle that never pushed", async () => {
    // Inngest re-invokes handle-message at every step boundary and each
    // invocation calls delivery.finish(). After the first real finish
    // releases the dedup slot, every later boundary opens a fresh handle,
    // pushes nothing, and finishes it — a turn-end frame from those
    // phantom handles would reset the tab's running indicator for the
    // NEXT queued turn. Only a handle that actually delivered something
    // closes the turn; abort stays unconditional (a failure before the
    // first delta still must reset the tab's UI).
    const { adapter, connect } = setup();
    const frames = connect("tab-1");

    // The invocation that streams: pushes, then finishes → one turn-end.
    const live = await adapter.openStream("tab-1", "run-1");
    await live.push({ type: "text_delta", text: "hello" });
    await live.finish();

    // Post-finish boundary re-invocations: fresh handles, no pushes.
    await (await adapter.openStream("tab-1", "run-1")).finish();
    await (await adapter.openStream("tab-1", "run-1")).finish();

    const turnEnds = frames.filter((f) => f.event === "turn-end");
    expect(turnEnds).toHaveLength(1);

    // An abort on an un-pushed handle still fires.
    await (await adapter.openStream("tab-1", "run-1")).abort("boom");
    expect(frames.at(-1)).toEqual({
      event: "turn-abort",
      data: JSON.stringify({ message: "boom" }),
    });
  });

  it("dedups by (runId, address) — a retry reopen returns the same handle", async () => {
    const { adapter } = setup();
    const first = await adapter.openStream("tab-1", "run-1");
    const again = await adapter.openStream("tab-1", "run-1");
    expect(again).toBe(first);
  });

  it("gives distinct handles to different tabs on the same run", async () => {
    const { adapter } = setup();
    const a = await adapter.openStream("tab-1", "run-1");
    const b = await adapter.openStream("tab-2", "run-1");
    expect(b).not.toBe(a);
  });

  it("releases the dedup slot on finish so a later reopen is fresh", async () => {
    const { adapter } = setup();
    const first = await adapter.openStream("tab-1", "run-1");
    await first.finish();
    const reopened = await adapter.openStream("tab-1", "run-1");
    expect(reopened).not.toBe(first);
  });

  it("drops frames when the tab has no live connection", async () => {
    const { adapter } = setup(); // no connect()
    const handle = await adapter.openStream("ghost", "run-1");
    await expect(handle.push({ type: "text_delta", text: "x" })).resolves.toBeUndefined();
  });
});
