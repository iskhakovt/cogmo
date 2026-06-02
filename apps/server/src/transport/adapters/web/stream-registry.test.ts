import { describe, expect, it } from "vitest";
import type { SseFrame } from "./stream-registry.js";
import { WebStreamRegistry } from "./stream-registry.js";

function recorder(): { send: (f: SseFrame) => void; frames: SseFrame[] } {
  const frames: SseFrame[] = [];
  return { send: (f) => frames.push(f), frames };
}

describe("WebStreamRegistry", () => {
  it("routes a frame to the registered connection", () => {
    const reg = new WebStreamRegistry();
    const conn = recorder();
    reg.register("tab-1", conn);
    expect(reg.send("tab-1", { data: "x" })).toBe(true);
    expect(conn.frames).toEqual([{ data: "x" }]);
  });

  it("returns false when no connection is registered for the address", () => {
    const reg = new WebStreamRegistry();
    expect(reg.send("missing", { data: "x" })).toBe(false);
  });

  it("deregister removes the connection", () => {
    const reg = new WebStreamRegistry();
    const off = reg.register("tab-1", recorder());
    expect(reg.size).toBe(1);
    off();
    expect(reg.size).toBe(0);
    expect(reg.send("tab-1", { data: "x" })).toBe(false);
  });

  it("a reconnect replaces the connection and the stale deregister is a no-op", () => {
    const reg = new WebStreamRegistry();
    const first = recorder();
    const second = recorder();
    const offFirst = reg.register("tab-1", first);
    reg.register("tab-1", second); // reconnect — same address, new connection

    // The stale connection's deregister must not evict the live one.
    offFirst();
    expect(reg.send("tab-1", { data: "y" })).toBe(true);
    expect(second.frames).toEqual([{ data: "y" }]);
    expect(first.frames).toEqual([]);
  });
});
