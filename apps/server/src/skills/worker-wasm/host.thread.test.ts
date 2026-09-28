import { EventEmitter } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { CtxHandler } from "../dispatcher.js";
import { type PyodideThread, type RunOnWorkerResult, runOnThread } from "./host.js";

/**
 * `runOnThread` against a stand-in thread: the test plays the Pyodide
 * worker on the far end of a real `MessageChannel`, and errors or exits the
 * thread at will. `host.test.ts` covers `runOnWorker` end to end against
 * real Pyodide.
 */

interface StandIn {
  thread: PyodideThread;
  /** The worker's end of the channel. */
  worker: MessagePort;
  interrupt: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function standIn(): StandIn {
  const channel = new MessageChannel();
  const interrupt = vi.fn();
  const terminate = vi.fn(async () => {
    channel.port2.close();
  });
  return {
    thread: { port: channel.port1, events: new EventEmitter(), interrupt, terminate },
    worker: channel.port2,
    interrupt,
    terminate,
  };
}

const WALL_CLOCK_S = 30;

function run(t: StandIn, wallClockS = WALL_CLOCK_S): Promise<RunOnWorkerResult> {
  return runOnThread(t.thread, {
    taskId: "task-1",
    skillName: "skill",
    body: "",
    inputs: {},
    wallClockS,
    readyTimeoutMs: 5_000,
    ctxHandler: mock<CtxHandler>(),
  });
}

/** Settle what is already in flight, without letting any timer run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await new Promise((r) => setImmediate(r));
  await vi.advanceTimersByTimeAsync(0);
}

/** Announce the thread ready and wait for the task it is handed. */
async function readyAndInvoked(t: StandIn): Promise<void> {
  const invoked = new Promise<void>((resolve) => {
    t.worker.on("message", (m: { type?: string }) => {
      if (m.type === "task_invoke") resolve();
    });
  });
  t.worker.postMessage({ type: "ready" });
  await settle();
  await invoked;
}

/** Track whether `promise` has settled. */
function watch(promise: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  return { settled: () => settled };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runOnThread", () => {
  it("settles a task on its result, with no wait for a task_exited", async () => {
    const t = standIn();
    const result = run(t);
    const watched = watch(result);
    await readyAndInvoked(t);

    t.worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: 1 });
    await settle();

    expect(watched.settled()).toBe(true);
    expect(await result).toEqual({ ok: true, output: 1 });
    expect(t.terminate).toHaveBeenCalled();
  });

  it("fails a task at once when its thread crashes mid-task", async () => {
    const t = standIn();
    const result = run(t);
    const watched = watch(result);
    await readyAndInvoked(t);

    t.thread.events.emit("error", new Error("out of memory"));
    await settle();

    expect(watched.settled()).toBe(true);
    expect(await result).toEqual({ ok: false, error: "worker crashed: out of memory" });
  });

  it("fails a task at once when its thread exits mid-task", async () => {
    const t = standIn();
    const result = run(t);
    const watched = watch(result);
    await readyAndInvoked(t);

    t.thread.events.emit("exit", 3);
    await settle();

    expect(watched.settled()).toBe(true);
    expect(await result).toEqual({ ok: false, error: "worker exited (code 3)" });
  });

  it("interrupts at the wall clock, and reports a crash after it as wall_clock_exceeded", async () => {
    const t = standIn();
    const result = run(t);
    await readyAndInvoked(t);

    await vi.advanceTimersByTimeAsync(WALL_CLOCK_S * 1000 - 1);
    expect(t.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.interrupt).toHaveBeenCalledTimes(1);

    t.thread.events.emit("error", new Error("KeyboardInterrupt"));
    await settle();

    expect(await result).toEqual({ ok: false, error: "wall_clock_exceeded" });
  });

  it("keeps a result that arrives in the grace window after the interrupt", async () => {
    const t = standIn();
    const result = run(t);
    await readyAndInvoked(t);

    await vi.advanceTimersByTimeAsync(WALL_CLOCK_S * 1000);
    expect(t.interrupt).toHaveBeenCalledTimes(1);
    t.worker.postMessage({ type: "task_result", id: "task-1", ok: false, error: "interrupted" });
    await settle();

    expect(await result).toEqual({ ok: false, error: "interrupted" });
  });

  it("fails a task with no result by the end of the grace window", async () => {
    const t = standIn();
    const result = run(t);
    const watched = watch(result);
    await readyAndInvoked(t);

    await vi.advanceTimersByTimeAsync(WALL_CLOCK_S * 1000 + 999);
    await settle();
    expect(watched.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(await result).toEqual({ ok: false, error: "wall_clock_exceeded" });
  });

  it("reports a thread that fails to load", async () => {
    const t = standIn();
    const result = run(t);
    t.worker.postMessage({ type: "fatal", error: "micropip: no matching wheel" });
    await settle();

    expect(await result).toEqual({
      ok: false,
      error: "worker init failed: micropip: no matching wheel",
    });
  });

  it("reports a thread that exits before it is ready", async () => {
    const t = standIn();
    const result = run(t);
    t.thread.events.emit("exit", 7);
    await settle();

    expect(await result).toEqual({
      ok: false,
      error: "worker init failed: worker exited (code 7)",
    });
  });

  it("reports a thread that is not ready by its deadline", async () => {
    const t = standIn();
    const result = run(t);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(await result).toEqual({ ok: false, error: "worker_init_timeout after 5000ms" });
    expect(t.terminate).toHaveBeenCalled();
  });
});
