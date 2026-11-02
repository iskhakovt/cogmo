import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerTransport } from "../dispatcher.js";
import type { TaskInvoke } from "../protocol.js";
import { createIpcTransport, type IpcChannel } from "./transport.js";

/** The host's end of a child's IPC channel; `emit` plays the child. */
class Channel extends EventEmitter implements IpcChannel {
  connected = true;
  readonly sent: unknown[] = [];
  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
  disconnect(): void {
    this.connected = false;
  }
}

interface Harness {
  transport: WorkerTransport;
  child: Channel;
}

const open: Harness[] = [];

function harness(): Harness {
  const child = new Channel();
  const h = { transport: createIpcTransport(child), child };
  open.push(h);
  return h;
}

afterEach(() => {
  for (const h of open.splice(0)) h.transport.close();
});

describe("createIpcTransport", () => {
  it("yields the child's frames, validated, and a task_exited after each task_result", async () => {
    const h = harness();
    const frames = h.transport.messages()[Symbol.asyncIterator]();
    const first = frames.next();
    h.child.emit("message", { type: "ready" });
    h.child.emit("message", { type: "task_result", id: "t1", ok: true, output: 1 });
    h.child.emit("message", { type: "nonsense" });

    expect((await first).value).toEqual({ type: "ready" });
    expect((await frames.next()).value).toEqual({
      type: "task_result",
      id: "t1",
      ok: true,
      output: 1,
    });
    expect((await frames.next()).value).toEqual({ type: "task_exited", id: "t1" });
    expect((await frames.next()).value).toMatchObject({ type: "malformed" });
  });

  it("fails the stream with the channel's error, and keeps later errors from escaping", async () => {
    const h = harness();
    const next = h.transport.messages()[Symbol.asyncIterator]().next();
    h.child.emit("error", new Error("channel closed"));

    await expect(next).rejects.toThrow("worker crashed: channel closed");
    expect(() => h.child.emit("error", new Error("again"))).not.toThrow();
  });

  it("fails the stream with the child's exit code", async () => {
    const h = harness();
    const next = h.transport.messages()[Symbol.asyncIterator]().next();
    h.child.emit("exit", 1, null);

    await expect(next).rejects.toThrow("worker exited (code 1)");
  });

  it("fails the stream with the signal that killed the child", async () => {
    const h = harness();
    const next = h.transport.messages()[Symbol.asyncIterator]().next();
    h.child.emit("exit", null, "SIGKILL");

    await expect(next).rejects.toThrow("worker exited (signal SIGKILL)");
  });

  it("ends the stream cleanly on close, disconnects, and keeps a later error from escaping", async () => {
    const h = harness();
    const next = h.transport.messages()[Symbol.asyncIterator]().next();
    h.transport.close();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(h.child.connected).toBe(false);
    expect(() => h.child.emit("error", new Error("late"))).not.toThrow();
  });

  it("sends host messages to the child, and drops them after close", () => {
    const h = harness();
    const invoke: TaskInvoke = { type: "task_invoke", id: "t1", skill: "s", inputs: {} };
    h.transport.send(invoke);
    h.transport.close();
    h.transport.send(invoke);

    expect(h.child.sent).toEqual([invoke]);
  });
});
