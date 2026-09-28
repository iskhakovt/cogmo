import { EventEmitter } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerTransport } from "../dispatcher.js";
import type { TaskInvoke } from "../protocol.js";
import { createPortTransport } from "./transport.js";

interface Harness {
  transport: WorkerTransport;
  /** The thread's end of the channel. */
  worker: MessagePort;
  /** Emits the thread's own `error` and `exit`. */
  thread: EventEmitter;
}

const open: Harness[] = [];

function harness(): Harness {
  const { port1, port2 } = new MessageChannel();
  const thread = new EventEmitter();
  const h = { transport: createPortTransport(port1, thread), worker: port2, thread };
  open.push(h);
  return h;
}

afterEach(() => {
  for (const h of open.splice(0)) {
    h.transport.close();
    h.worker.close();
  }
});

describe("createPortTransport", () => {
  it("yields the thread's frames, validated, and a task_exited after each task_result", async () => {
    const h = harness();
    const frames = h.transport.messages()[Symbol.asyncIterator]();
    h.worker.postMessage({ type: "ready" });
    h.worker.postMessage({ type: "task_result", id: "t1", ok: true, output: 1 });
    h.worker.postMessage({ type: "nonsense" });

    expect((await frames.next()).value).toEqual({ type: "ready" });
    expect((await frames.next()).value).toEqual({
      type: "task_result",
      id: "t1",
      ok: true,
      output: 1,
    });
    expect((await frames.next()).value).toEqual({ type: "task_exited", id: "t1" });
    expect((await frames.next()).value).toMatchObject({ type: "malformed" });
  });

  it("fails the stream with the thread's crash, and keeps later errors from escaping", async () => {
    const h = harness();
    const next = h.transport.messages()[Symbol.asyncIterator]().next();
    h.thread.emit("error", new Error("out of memory"));

    await expect(next).rejects.toThrow("worker crashed: out of memory");
    expect(() => h.thread.emit("error", new Error("KeyboardInterrupt"))).not.toThrow();
  });

  it("fails the stream with the thread's exit code", async () => {
    const h = harness();
    const next = h.transport.messages()[Symbol.asyncIterator]().next();
    h.thread.emit("exit", 1);

    await expect(next).rejects.toThrow("worker exited (code 1)");
  });

  it("ends the stream cleanly on close, and keeps a later thread error from escaping", async () => {
    const h = harness();
    const next = h.transport.messages()[Symbol.asyncIterator]().next();
    h.transport.close();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(() => h.thread.emit("error", new Error("KeyboardInterrupt"))).not.toThrow();
  });

  it("sends host messages to the thread", async () => {
    const h = harness();
    const invoke: TaskInvoke = { type: "task_invoke", id: "t1", skill: "s", inputs: {} };
    const received = new Promise((resolve) => h.worker.once("message", resolve));
    h.transport.send(invoke);

    await expect(received).resolves.toEqual(invoke);
  });
});
