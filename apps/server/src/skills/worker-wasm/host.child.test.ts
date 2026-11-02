import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { CtxHandler } from "../dispatcher.js";
import type { HostMessage } from "../protocol.js";
import { type RunOnWorkerResult, runOnChild, type Tier1Child } from "./host.js";
import type { IpcChannel } from "./transport.js";

/**
 * `runOnChild` against a stand-in child: the test plays the tier-1 child on
 * the far end of its IPC channel, and errors or exits it at will.
 * `host.test.ts` covers `runOnWorker` end to end against real children.
 */

class StandInChannel extends EventEmitter implements IpcChannel {
  connected = true;
  readonly sent: unknown[] = [];
  send(message: unknown): boolean {
    this.sent.push(message);
    this.emit("sent", message);
    return true;
  }
  disconnect(): void {
    this.connected = false;
  }
}

interface StandIn {
  child: Tier1Child;
  ipc: StandInChannel;
  interrupt: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function standIn(): StandIn {
  const ipc = new StandInChannel();
  const exited = Promise.withResolvers<void>();
  const interrupt = vi.fn();
  // Killing the child exits it, as the real one's SIGKILL does.
  const kill = vi.fn(() => {
    ipc.emit("exit", null, "SIGKILL");
    exited.resolve();
  });
  return { child: { ipc, interrupt, kill, exited: exited.promise }, ipc, interrupt, kill };
}

const WALL_CLOCK_S = 30;

function run(t: StandIn, wallClockS = WALL_CLOCK_S): Promise<RunOnWorkerResult> {
  return runOnChild(t.child, {
    taskId: "task-1",
    skillName: "skill",
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

/** Announce the child ready and wait for the task it is handed. */
async function readyAndInvoked(t: StandIn): Promise<void> {
  const invoked = new Promise<void>((resolve) => {
    t.ipc.on("sent", (m: HostMessage) => {
      if (m.type === "task_invoke") resolve();
    });
  });
  t.ipc.emit("message", { type: "ready" });
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

describe("runOnChild", () => {
  it("settles a task on its result, with no wait for a task_exited", async () => {
    const t = standIn();
    const result = run(t);
    const watched = watch(result);
    await readyAndInvoked(t);

    t.ipc.emit("message", { type: "task_result", id: "task-1", ok: true, output: 1 });
    await settle();

    expect(watched.settled()).toBe(true);
    expect(await result).toEqual({ ok: true, output: 1 });
    expect(t.kill).toHaveBeenCalled();
  });

  it("fails a task at once when its child's channel errors mid-task", async () => {
    const t = standIn();
    const result = run(t);
    const watched = watch(result);
    await readyAndInvoked(t);

    t.ipc.emit("error", new Error("out of memory"));
    await settle();

    expect(watched.settled()).toBe(true);
    expect(await result).toEqual({ ok: false, error: "worker crashed: out of memory" });
  });

  it("fails a task at once when its child exits mid-task", async () => {
    const t = standIn();
    const result = run(t);
    const watched = watch(result);
    await readyAndInvoked(t);

    t.ipc.emit("exit", 3, null);
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

    t.ipc.emit("error", new Error("KeyboardInterrupt"));
    await settle();

    expect(await result).toEqual({ ok: false, error: "wall_clock_exceeded" });
  });

  it("reports a result that arrives after the interrupt as wall_clock_exceeded", async () => {
    // A skill can catch KeyboardInterrupt and return normally.
    const t = standIn();
    const result = run(t);
    await readyAndInvoked(t);

    await vi.advanceTimersByTimeAsync(WALL_CLOCK_S * 1000);
    expect(t.interrupt).toHaveBeenCalledTimes(1);
    t.ipc.emit("message", { type: "task_result", id: "task-1", ok: true, output: { ok: true } });
    await settle();

    expect(await result).toEqual({ ok: false, error: "wall_clock_exceeded" });
    expect(t.kill).toHaveBeenCalled();
  });

  it("keeps a result that arrives before the wall clock", async () => {
    const t = standIn();
    const result = run(t);
    await readyAndInvoked(t);

    await vi.advanceTimersByTimeAsync(WALL_CLOCK_S * 1000 - 1);
    t.ipc.emit("message", { type: "task_result", id: "task-1", ok: false, error: "boom" });
    await settle();

    expect(await result).toEqual({ ok: false, error: "boom" });
    expect(t.interrupt).not.toHaveBeenCalled();
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

  it("reports a child that fails to load", async () => {
    const t = standIn();
    const result = run(t);
    t.ipc.emit("message", { type: "fatal", error: "micropip: no matching wheel" });
    await settle();

    expect(await result).toEqual({
      ok: false,
      error: "worker init failed: micropip: no matching wheel",
    });
  });

  it("reports a child that exits before it is ready", async () => {
    const t = standIn();
    const result = run(t);
    t.ipc.emit("exit", 7, null);
    await settle();

    expect(await result).toEqual({
      ok: false,
      error: "worker init failed: worker exited (code 7)",
    });
  });

  it("reports a real child that throws as it loads, without waiting out its deadline", async () => {
    // The deadline's timer is faked, so only the child's exit can settle the task.
    const proc = spawn(process.execPath, ["-e", "throw new Error('boom')"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    try {
      const result = await runOnChild(
        { ipc: proc, interrupt: () => {}, kill: () => proc.kill("SIGKILL"), exited },
        {
          taskId: "task-1",
          skillName: "skill",
          inputs: {},
          readyTimeoutMs: 5_000,
          ctxHandler: mock<CtxHandler>(),
        },
      );

      expect(result).toEqual({ ok: false, error: "worker init failed: worker exited (code 1)" });
    } finally {
      // A failed assertion or a hang must not leave the process behind.
      proc.kill("SIGKILL");
    }
  });

  it("reports a child that is not ready by its deadline", async () => {
    const t = standIn();
    const result = run(t);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(await result).toEqual({ ok: false, error: "worker_init_timeout after 5000ms" });
    expect(t.kill).toHaveBeenCalled();
  });
});
