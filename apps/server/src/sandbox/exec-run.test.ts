import type { Writable } from "node:stream";
import { err, ok, type Result } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { expectDefined } from "../test/assertions.js";
import { ExecDisposedError, ExecTimeoutError } from "./exec.js";
import { type ExecBackend, type ExecSink, runExec, TEARDOWN_TIMEOUT_MS } from "./exec-run.js";

/**
 * A backend the test drives: `start`, `fetchExit` and `teardown` each wait
 * on a gate the test opens, and `calls` records their order.
 */
function fakeBackend(opts: { buffersStdin?: boolean } = {}) {
  const started = Promise.withResolvers<{ stdin?: Writable }>();
  const exit = Promise.withResolvers<Result<number, string>>();
  let tornDown = Promise.withResolvers<void>();
  tornDown.resolve();
  const calls: string[] = [];
  const backend = mock<ExecBackend>({ buffersStdin: opts.buffersStdin ?? false, logFields: {} });
  backend.start.mockImplementation(() => {
    calls.push("start");
    return started.promise;
  });
  backend.fetchExit.mockImplementation(() => {
    calls.push("fetchExit");
    return exit.promise;
  });
  backend.teardown.mockImplementation(() => {
    calls.push("teardown");
    return tornDown.promise;
  });
  return {
    backend,
    started,
    exit,
    calls,
    sink: (): ExecSink => expectDefined(backend.start.mock.calls[0], "start call")[0],
    startSignal: (): AbortSignal => expectDefined(backend.start.mock.calls[0], "start call")[2],
    /** From now on, a teardown waits until the returned gate opens. */
    holdTeardown: () => {
      tornDown = Promise.withResolvers<void>();
      return tornDown;
    },
  };
}

/** Let every pending promise callback run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runExec", () => {
  it("hands over the handle once the command runs, and settles with its exit code", async () => {
    vi.useFakeTimers();
    const f = fakeBackend();
    let opened = false;
    const opening = runExec(f.backend, {}).then((h) => {
      opened = true;
      return h;
    });
    await flush();
    expect(opened).toBe(false);

    f.started.resolve({});
    const handle = await opening;
    const out: Buffer[] = [];
    handle.stdout.on("data", (c: Buffer) => out.push(c));
    f.sink().output("stdout", Buffer.from("hi\n"));
    f.sink().ended();
    f.exit.resolve(ok(7));

    expect(await handle.exited).toEqual(ok({ exitCode: 7 }));
    await expect(handle.wait()).resolves.toEqual({ exitCode: 7 });
    expect(Buffer.concat(out).toString()).toBe("hi\n");
    expect(f.calls).toEqual(["start", "fetchExit", "teardown"]);
  });

  it("rejects with the start's error and tears down what it acquired", async () => {
    const f = fakeBackend();
    const failure = new Error("no cmdId");
    f.started.reject(failure);
    await expect(runExec(f.backend, {})).rejects.toBe(failure);
    expect(f.calls).toEqual(["start", "teardown"]);
  });

  it("bounds the start: a deadline mid-start rejects, stops the start, and tears down what it finishes with", async () => {
    vi.useFakeTimers();
    const f = fakeBackend();
    const opening = runExec(f.backend, { timeoutMs: 1_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await opening).toBeInstanceOf(ExecTimeoutError);
    expect(f.startSignal().aborted).toBe(true);
    expect(f.calls).toEqual(["start", "teardown"]);

    f.started.resolve({});
    await flush();
    expect(f.calls).toEqual(["start", "teardown", "teardown"]);
  });

  it("settles on a deadline at once, however long the teardown takes", async () => {
    vi.useFakeTimers();
    const f = fakeBackend();
    f.started.resolve({});
    const handle = await runExec(f.backend, { timeoutMs: 1_000 });
    f.holdTeardown();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await handle.exited).toEqual(
      err({ kind: "timed_out", deadline: "total", timeoutMs: 1_000 }),
    );
    const teardownSignal = expectDefined(f.backend.teardown.mock.calls[0], "teardown")[0];
    expect(teardownSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(TEARDOWN_TIMEOUT_MS);
    expect(teardownSignal.aborted).toBe(true);
  });

  it("retries a teardown that failed on the next dispose, and only then", async () => {
    const f = fakeBackend();
    f.started.resolve({});
    const handle = await runExec(f.backend, {});
    f.backend.teardown.mockRejectedValueOnce(new Error("daemon unreachable"));
    f.sink().ended();
    f.exit.resolve(ok(0));
    await handle.exited;
    // Let the failed teardown report back before disposing.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.backend.teardown).toHaveBeenCalledTimes(1);

    await handle.dispose();
    expect(f.backend.teardown).toHaveBeenCalledTimes(2);
    await handle.dispose();
    expect(f.backend.teardown).toHaveBeenCalledTimes(2);
  });

  it("retries a teardown that timed out on the next dispose", async () => {
    vi.useFakeTimers();
    const f = fakeBackend();
    f.started.resolve({});
    const handle = await runExec(f.backend, { timeoutMs: 1_000 });
    f.holdTeardown();
    await vi.advanceTimersByTimeAsync(1_000 + TEARDOWN_TIMEOUT_MS);
    expect(f.backend.teardown).toHaveBeenCalledTimes(1);

    void handle.dispose();
    await flush();
    expect(f.backend.teardown).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(TEARDOWN_TIMEOUT_MS);
  });

  it("a single dispose retries the teardown it arrived during, when that one fails", async () => {
    const f = fakeBackend();
    f.started.resolve({});
    f.backend.teardown
      .mockImplementationOnce(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("flaky")), 20)),
      )
      .mockResolvedValueOnce(undefined);
    const handle = await runExec(f.backend, {});
    f.sink().ended();
    f.exit.resolve(ok(0));

    try {
      await handle.wait();
    } finally {
      await handle.dispose();
    }

    expect(f.backend.teardown).toHaveBeenCalledTimes(2);
  });

  it("dispose() from a data handler resolves only after the teardown it caused", async () => {
    vi.useFakeTimers();
    const f = fakeBackend();
    f.started.resolve({});
    const handle = await runExec(f.backend, {});
    const teardown = f.holdTeardown();
    let disposed = false;
    handle.stdout.on("data", () => {
      void handle.dispose().then(() => {
        disposed = true;
      });
    });

    f.sink().output("stdout", Buffer.from("x"));
    await flush();
    expect(f.backend.teardown).toHaveBeenCalledTimes(1);
    expect(disposed).toBe(false);

    teardown.resolve();
    await flush();
    expect(disposed).toBe(true);
  });

  it("dispose() while the start is in flight resolves only after the late start's teardown", async () => {
    vi.useFakeTimers();
    const f = fakeBackend({ buffersStdin: true });
    const handle = await runExec(f.backend, {});
    expectDefined(handle.stdin, "stdin").end();
    await vi.waitFor(() => expect(f.backend.start).toHaveBeenCalled());
    let disposed = false;
    void handle.dispose().then(() => {
      disposed = true;
    });
    await flush();
    expect(f.backend.teardown).toHaveBeenCalledTimes(1);
    expect(disposed).toBe(false);

    f.started.resolve({});
    await flush();
    expect(f.backend.teardown).toHaveBeenCalledTimes(2);
    expect(disposed).toBe(true);
  });

  it("clears the total deadline when the run settles", async () => {
    vi.useFakeTimers();
    const f = fakeBackend();
    f.started.resolve({});
    const handle = await runExec(f.backend, { timeoutMs: 60_000 });
    f.sink().ended();
    f.exit.resolve(ok(0));
    await handle.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the idle deadline on output, not on every write", async () => {
    vi.useFakeTimers();
    const f = fakeBackend();
    f.started.resolve({});
    const handle = await runExec(f.backend, { idleTimeoutMs: 100 });
    handle.stderr.resume();
    f.sink().ended();
    // Draining: the backend writes what it drains (the PTY's stderr) with
    // no idle restart, so the fetch keeps one idle window.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(40);
      f.sink().output("stderr", Buffer.from("drained"));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(await handle.exited).toEqual(
      err({ kind: "timed_out", deadline: "idle", timeoutMs: 100 }),
    );
  });

  it("restarts the idle deadline on every chunk", async () => {
    vi.useFakeTimers();
    const f = fakeBackend();
    f.started.resolve({});
    const handle = await runExec(f.backend, { idleTimeoutMs: 100 });
    handle.stdout.resume();
    let settled = false;
    void handle.exited.then(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(90);
      f.sink().output("stdout", Buffer.from("tick"));
    }
    await flush();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await handle.exited).toEqual(
      err({ kind: "timed_out", deadline: "idle", timeoutMs: 100 }),
    );
  });

  it("disposes when the caller's signal aborts", async () => {
    const f = fakeBackend();
    f.started.resolve({});
    const controller = new AbortController();
    const handle = await runExec(f.backend, { signal: controller.signal });
    controller.abort();
    expect(await handle.exited).toEqual(err({ kind: "disposed" }));
    await expect(handle.wait()).rejects.toBeInstanceOf(ExecDisposedError);
  });

  it("never starts for a signal that aborted already", async () => {
    const f = fakeBackend();
    const controller = new AbortController();
    controller.abort();
    await expect(runExec(f.backend, { signal: controller.signal })).rejects.toBeInstanceOf(
      ExecDisposedError,
    );
    expect(f.backend.start).not.toHaveBeenCalled();
    expect(f.backend.teardown).not.toHaveBeenCalled();
  });

  it("fails both streams on a transport failure without crashing an unread one", async () => {
    const f = fakeBackend();
    f.started.resolve({});
    const handle = await runExec(f.backend, {});
    const failure = new Error("socket reset");
    f.sink().failed(failure);

    expect(await handle.exited).toEqual(err({ kind: "transport_failed", error: failure }));
    await expect(handle.wait()).rejects.toBe(failure);
    await expect(handle.stdout.toArray()).rejects.toBe(failure);
    expect(handle.stderr.destroyed).toBe(true);
  });

  it("reports a transport that fails while the start returns through `exited`, not the start", async () => {
    const f = fakeBackend();
    const failure = new Error("ws dropped");
    f.backend.start.mockImplementation(async (sink) => {
      sink.output("stdout", Buffer.from("partial"));
      sink.failed(failure);
      return {};
    });
    const handle = await runExec(f.backend, {});
    expect(await handle.exited).toEqual(err({ kind: "transport_failed", error: failure }));
  });

  it("drops output that arrives after settlement", async () => {
    const f = fakeBackend();
    f.started.resolve({});
    const handle = await runExec(f.backend, {});
    await handle.dispose();
    f.sink().output("stdout", Buffer.from("late"));
    expect(await handle.stdout.toArray()).toEqual([]);
  });

  it("runs a dispose raised by a consumer mid-effect after that effect, arming nothing after settlement", async () => {
    vi.useFakeTimers();
    const f = fakeBackend();
    f.started.resolve({});
    const handle = await runExec(f.backend, { idleTimeoutMs: 1_000 });
    handle.stdout.on("data", () => {
      void handle.dispose();
    });
    f.sink().output("stdout", Buffer.from("x"));
    await flush();
    expect(await handle.exited).toEqual(err({ kind: "disposed" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("a backend that buffers stdin", () => {
    it("starts with the whole payload once the caller ends stdin", async () => {
      const f = fakeBackend({ buffersStdin: true });
      const handle = await runExec(f.backend, {});
      const stdin = expectDefined(handle.stdin, "stdin");
      stdin.write("a");
      stdin.end("b");
      await vi.waitFor(() => expect(f.backend.start).toHaveBeenCalled());
      expect(expectDefined(f.backend.start.mock.calls[0], "start")[1]?.toString()).toBe("ab");
    });

    it("closes stdin when the run settles first, so later writes fail quietly", async () => {
      const f = fakeBackend({ buffersStdin: true });
      const handle = await runExec(f.backend, {});
      await handle.dispose();
      const stdin = expectDefined(handle.stdin, "stdin");
      const written = await new Promise<Error | null | undefined>((resolve) =>
        stdin.write("late", resolve),
      );
      expect(written).toBeInstanceOf(Error);
      expect(f.backend.start).not.toHaveBeenCalled();
      expect(await handle.exited).toEqual(err({ kind: "disposed" }));
    });
  });
});
