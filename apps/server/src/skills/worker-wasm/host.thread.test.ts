import { type EventEmitter, once } from "node:events";
import type { MessagePort } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { expectDefined } from "../../test/assertions.js";
import type { CtxHandler } from "../dispatcher.js";
import { type RunOnWorkerParams, runOnWorker } from "./host.js";

/**
 * `runOnWorker` against a stand-in thread: the test plays the Pyodide
 * worker over the real `MessagePort` it was handed, and crashes or exits
 * the thread at will. `host.test.ts` covers the same function end to end
 * against real Pyodide.
 */

interface FakeThread {
  thread: EventEmitter;
  port: MessagePort;
  interrupt: Uint8Array;
}

const threads = vi.hoisted((): FakeThread[] => []);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  class FakeWorker extends EventEmitter {
    constructor(
      _entry: URL,
      opts: { workerData: { port: MessagePort; interruptBuffer: SharedArrayBuffer } },
    ) {
      super();
      threads.push({
        thread: this,
        port: opts.workerData.port,
        interrupt: new Uint8Array(opts.workerData.interruptBuffer),
      });
    }
    async terminate(): Promise<number> {
      this.emit("exit", 1);
      return 1;
    }
  }
  return { ...actual, Worker: FakeWorker };
});

function run(overrides: Partial<RunOnWorkerParams>): Promise<unknown> {
  return runOnWorker({
    taskId: "task-1",
    skillName: "skill",
    body: "",
    inputs: {},
    ctxHandler: mock<CtxHandler>(),
    ...overrides,
  });
}

/** The thread `runOnWorker` just spawned. */
async function spawned(): Promise<FakeThread> {
  await vi.waitFor(() => expect(threads).toHaveLength(1));
  return expectDefined(threads.shift(), "spawned thread");
}

/** Announce the thread ready and wait for the task it is handed. */
async function readyAndInvoked(t: FakeThread): Promise<void> {
  const invoked = once(t.port, "message");
  t.port.postMessage({ type: "ready" });
  await invoked;
}

describe("runOnWorker (thread lifecycle)", () => {
  it("fails a task at once when its thread crashes mid-task", async () => {
    const result = run({ wallClockS: 30 });
    const t = await spawned();
    await readyAndInvoked(t);

    const crashedAt = Date.now();
    t.thread.emit("error", new Error("out of memory"));

    expect(await result).toEqual({ ok: false, error: "worker crashed: out of memory" });
    expect(Date.now() - crashedAt).toBeLessThan(1000);
  });

  it("reports wall_clock_exceeded when the interrupt kills the thread", async () => {
    const result = run({ wallClockS: 0.05 });
    const t = await spawned();
    await readyAndInvoked(t);

    await vi.waitFor(() => expect(t.interrupt[0]).toBe(2));
    t.thread.emit("error", new Error("KeyboardInterrupt"));

    expect(await result).toEqual({ ok: false, error: "wall_clock_exceeded" });
  });

  it("keeps a result that arrives in the grace window after the interrupt", async () => {
    const result = run({ wallClockS: 0.05 });
    const t = await spawned();
    await readyAndInvoked(t);

    await vi.waitFor(() => expect(t.interrupt[0]).toBe(2));
    t.port.postMessage({ type: "task_result", id: "task-1", ok: true, output: 1 });

    expect(await result).toEqual({ ok: true, output: 1 });
  });

  it("reports a thread that fails to load", async () => {
    const result = run({});
    const t = await spawned();
    t.port.postMessage({ type: "fatal", error: "micropip: no matching wheel" });

    expect(await result).toEqual({
      ok: false,
      error: "worker init failed: micropip: no matching wheel",
    });
  });

  it("reports a thread that exits before it is ready", async () => {
    const result = run({});
    const t = await spawned();
    t.thread.emit("exit", 7);

    expect(await result).toEqual({
      ok: false,
      error: "worker init failed: worker exited (code 7)",
    });
  });
});
