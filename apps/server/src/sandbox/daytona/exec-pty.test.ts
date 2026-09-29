import { DaytonaNotFoundError, type PtyHandle, type PtyResult } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { ExecDisposedError, ExecTimeoutError } from "../index.js";
import { type PtyFileSystemClient, type PtyProcessClient, startExecPty } from "./exec-pty.js";

/**
 * PTY stub. Tests need to (a) trigger `onData` from outside (to drive
 * the consumer) and (b) resolve/reject `wait()` on cue, so the methods
 * we exercise get explicit `mockImplementation`s wired to closure state
 * the test can read back. Everything else stays auto-mocked.
 */
interface FakePtyControl {
  pty: PtyHandle;
  emitData: (chunk: string | Uint8Array) => void;
  resolveWait: (result: PtyResult) => void;
  rejectWait: (err: Error) => void;
  /**
   * The WebSocket closes abnormally (1006): a `wait()` already registered
   * resolves with no exit code, and one first called afterwards never
   * settles — the SDK's behaviour.
   */
  closeAbnormally: () => void;
  sendInputs: string[];
  killed: boolean;
  disconnected: boolean;
}

function fakePty(): FakePtyControl {
  let resolveWait!: (r: PtyResult) => void;
  let rejectWait!: (err: Error) => void;
  const waitPromise = new Promise<PtyResult>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  let closed = false;

  const pty = mock<PtyHandle>();
  const ctrl: FakePtyControl = {
    pty,
    emitData: () => {
      throw new Error("emitData called before onData attached");
    },
    resolveWait,
    rejectWait,
    closeAbnormally: () => {
      closed = true;
      resolveWait({});
    },
    sendInputs: [],
    killed: false,
    disconnected: false,
  };

  pty.waitForConnection.mockResolvedValue();
  pty.sendInput.mockImplementation(async (data: string | Uint8Array) => {
    ctrl.sendInputs.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  });
  pty.wait.mockImplementation(() => (closed ? new Promise<PtyResult>(() => {}) : waitPromise));
  pty.kill.mockImplementation(async () => {
    ctrl.killed = true;
    // A kill closes the PTY, which resolves `wait()` with no exit code.
    resolveWait({});
  });
  pty.disconnect.mockImplementation(async () => {
    ctrl.disconnected = true;
  });

  return ctrl;
}

interface FakeFsControl {
  fs: PtyFileSystemClient;
  uploaded: { remotePath: string; content: Buffer }[];
  deleted: string[];
  /** Bytes the stderr tmpfile holds when downloadFile is called. */
  stderrPayload: Buffer;
}

function fakeFs(): FakeFsControl {
  const uploaded: { remotePath: string; content: Buffer }[] = [];
  const deleted: string[] = [];
  const fs = mock<PtyFileSystemClient>();
  const ctrl: FakeFsControl = { fs, uploaded, deleted, stderrPayload: Buffer.alloc(0) };

  fs.uploadFile.mockImplementation(async (file: Buffer, remotePath: string) => {
    uploaded.push({ remotePath, content: Buffer.from(file) });
  });
  fs.downloadFile.mockImplementation(async (remotePath: string) => {
    if (remotePath.includes("stderr")) return ctrl.stderrPayload;
    throw new Error(`unexpected downloadFile path: ${remotePath}`);
  });
  fs.deleteFile.mockImplementation(async (path: string) => {
    deleted.push(path);
  });

  return ctrl;
}

interface FakeProcessControl {
  process: PtyProcessClient;
  /** Captures the options createPty was called with. */
  createPtyOptions: { envs?: Record<string, string>; cwd?: string; id?: string } | undefined;
}

function fakeProcess(pty: FakePtyControl): FakeProcessControl {
  const proc = mock<PtyProcessClient>();
  const ctrl: FakeProcessControl = { process: proc, createPtyOptions: undefined };
  proc.createPty.mockImplementation(async (options) => {
    ctrl.createPtyOptions = options;
    pty.emitData = (chunk: string | Uint8Array): void => {
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      void options.onData(bytes);
    };
    return pty.pty;
  });
  return ctrl;
}

function deterministicRandom(): () => string {
  let n = 0;
  return () => `fixed-${n++}`;
}

describe("startExecPty", () => {
  it("uploads stdin to a tmpfile, exec's the cmd with file redirect, streams onData to stdout", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);

    const handle = await startExecPty({
      process: procCtrl.process,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["claude", "-p", "--output-format", "stream-json"],
      opts: { attachStdin: true, workingDir: "/workspace", env: { FOO: "bar" } },
      random: deterministicRandom(),
    });

    expect(handle.stdin).toBeDefined();
    handle.stdin?.write('{"type":"user","message":{"role":"user","content":"hi"}}\n');
    handle.stdin?.end();

    // Wait for the uploader + PTY-start path to settle.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Upload happened with the full buffered stdin payload.
    expect(fsCtrl.uploaded).toHaveLength(1);
    const upload = fsCtrl.uploaded[0];
    expect(upload).toBeDefined();
    expect(upload?.content.toString("utf8")).toBe(
      '{"type":"user","message":{"role":"user","content":"hi"}}\n',
    );
    expect(upload?.remotePath).toMatch(/^\/tmp\/cogmo-pty-stdin-fixed-\d+\.bin$/);

    // The exec line wraps the cmd inside `bash --norc --noprofile -c`
    // so the default interactive PTY shell gets replaced atomically by
    // a non-interactive bash that doesn't run readline or fire
    // PROMPT_COMMAND. The inner script pipes stdin via `cat` (a real
    // pipe FD — claude 2.1.138 silently exits on file-FD stdin) and
    // redirects stderr to a tmpfile so onData carries only stdout.
    // Assert the full structure (envelope + inner script shape) so a
    // quoting/redirection regression in the wrapper is caught here
    // instead of leaking out as a downstream shell-parse error.
    expect(ptyCtrl.sendInputs).toHaveLength(1);
    const sent = ptyCtrl.sendInputs[0] ?? "";
    const envelopeMatch = sent.match(/^exec bash --norc --noprofile -c '(.*)'\n$/s);
    expect(envelopeMatch).not.toBeNull();
    // Bash single-quote escape: every inner `'` becomes `'"'"'` (close
    // single-quote, double-quote a literal single, reopen single-quote).
    // Reverse the escape to recover the literal script body the inner
    // bash will execute, then assert its shape.
    const innerScript = (envelopeMatch?.[1] ?? "").replaceAll(`'"'"'`, "'");
    expect(innerScript).toMatch(
      /^cat '\/tmp\/cogmo-pty-stdin-fixed-\d+\.bin' \| exec 'claude' '-p' '--output-format' 'stream-json' 2> '\/tmp\/cogmo-pty-stderr-fixed-\d+\.log'$/,
    );

    // onData → stdout pass-through.
    const stdoutChunks: Buffer[] = [];
    handle.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    ptyCtrl.emitData('{"type":"system","subtype":"init","session_id":"sid"}\n');

    // Settle the PTY with exit 0; the runner drains stderr tmpfile +
    // cleans up.
    fsCtrl.stderrPayload = Buffer.from("warn: something\n");
    ptyCtrl.resolveWait({ exitCode: 0 });

    const { exitCode } = await handle.wait();
    expect(exitCode).toBe(0);

    expect(Buffer.concat(stdoutChunks).toString("utf8")).toBe(
      '{"type":"system","subtype":"init","session_id":"sid"}\n',
    );

    expect(fsCtrl.fs.downloadFile).toHaveBeenCalledWith(
      expect.stringMatching(/stderr-fixed-\d+\.log$/),
    );

    // Tmpfile cleanup ran for both upload and stderr paths.
    expect(fsCtrl.deleted).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/tmp\/cogmo-pty-stdin-fixed-\d+\.bin$/),
        expect.stringMatching(/^\/tmp\/cogmo-pty-stderr-fixed-\d+\.log$/),
      ]),
    );
  });

  it("truncates oversized stderr at the cap with a marker", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);
    // 2 MiB > 1 MiB cap; the wrapper must clip the payload and
    // append a truncation marker so downstream consumers see the
    // breach explicitly instead of silently losing bytes.
    const oversized = Buffer.alloc(2 * 1024 * 1024, "x");
    fsCtrl.stderrPayload = oversized;

    const handle = await startExecPty({
      process: procCtrl.process,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: { attachStdin: true },
      random: deterministicRandom(),
    });
    handle.stdin?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stderrChunks: Buffer[] = [];
    handle.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    ptyCtrl.resolveWait({ exitCode: 0 });
    await handle.wait();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stderrText = Buffer.concat(stderrChunks).toString("utf8");
    // Capped at 1 MiB of payload bytes plus the truncation marker.
    expect(stderrText.length).toBeGreaterThan(1024 * 1024);
    expect(stderrText.length).toBeLessThan(1024 * 1024 + 200);
    expect(stderrText).toContain("[cogmo: stderr truncated]");
  });

  it("suppresses the bash prompt via PS1='' alongside NO_COLOR=1", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);

    const handle = await startExecPty({
      process: procCtrl.process,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: { attachStdin: true },
      random: deterministicRandom(),
    });
    handle.stdin?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(procCtrl.createPtyOptions?.envs).toEqual({ PS1: "", NO_COLOR: "1" });

    ptyCtrl.resolveWait({ exitCode: 0 });
    await handle.wait();
  });

  it("merges opts.env over a NO_COLOR default in PTY envs", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);

    const handle = await startExecPty({
      process: procCtrl.process,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: { attachStdin: true, env: { OTHER: "val" } },
      random: deterministicRandom(),
    });
    handle.stdin?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(procCtrl.createPtyOptions?.envs).toEqual({ PS1: "", NO_COLOR: "1", OTHER: "val" });

    ptyCtrl.resolveWait({ exitCode: 0 });
    await handle.wait();
  });

  it("caller-provided env wins over the NO_COLOR default", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);

    const handle = await startExecPty({
      process: procCtrl.process,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: { attachStdin: true, env: { NO_COLOR: "0" } },
      random: deterministicRandom(),
    });
    handle.stdin?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(procCtrl.createPtyOptions?.envs).toEqual({ PS1: "", NO_COLOR: "0" });

    ptyCtrl.resolveWait({ exitCode: 0 });
    await handle.wait();
  });

  it("total timer fires while parked on stdin.end() (caller never ends)", async () => {
    vi.useFakeTimers();
    try {
      const ptyCtrl = fakePty();
      const fsCtrl = fakeFs();
      const procCtrl = fakeProcess(ptyCtrl);

      const handle = await startExecPty({
        process: procCtrl.process,
        fs: fsCtrl.fs,
        sessionIdPrefix: "p",
        cmd: ["true"],
        opts: { attachStdin: true, timeoutMs: 1_000 },
        random: deterministicRandom(),
      });
      // No `handle.stdin.end()`: the run waits for stdin.
      const failure = handle.wait().catch((err: Error) => err);

      await vi.advanceTimersByTimeAsync(1_001);

      const err = await failure;
      if (!(err instanceof ExecTimeoutError)) {
        throw new Error(`expected ExecTimeoutError, got ${String(err)}`);
      }
      expect(err.kind).toBe("total");
      // The pre-end wait gets unblocked before createPty is ever called.
      expect(procCtrl.process.createPty).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("total timer fires during fs.uploadFile (before createPty)", async () => {
    vi.useFakeTimers();
    try {
      const ptyCtrl = fakePty();
      const fsCtrl = fakeFs();
      const procCtrl = fakeProcess(ptyCtrl);
      // Make upload take longer than the total timeout.
      vi.mocked(fsCtrl.fs.uploadFile).mockImplementationOnce(
        () => new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      );

      const handle = await startExecPty({
        process: procCtrl.process,
        fs: fsCtrl.fs,
        sessionIdPrefix: "p",
        cmd: ["true"],
        opts: { attachStdin: true, timeoutMs: 1_000 },
        random: deterministicRandom(),
      });
      handle.stdin?.end();
      const failure = handle.wait().catch((err: Error) => err);

      await vi.advanceTimersByTimeAsync(5_001);

      const err = await failure;
      if (!(err instanceof ExecTimeoutError)) {
        throw new Error(`expected ExecTimeoutError, got ${String(err)}`);
      }
      expect(err.kind).toBe("total");
      // The start sees the settlement once the slow upload returns, and
      // stops before `createPty`.
      expect(procCtrl.process.createPty).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("the total deadline bounds every remote step", () => {
    const never = <T>(): Promise<T> => new Promise<T>(() => {});
    const hangs: ReadonlyArray<{
      step: string;
      hang: (pty: FakePtyControl, fs: FakeFsControl, proc: FakeProcessControl) => void;
    }> = [
      {
        step: "fs.uploadFile",
        hang: (_pty, fs) => vi.mocked(fs.fs.uploadFile).mockImplementation(never),
      },
      {
        step: "createPty",
        hang: (_pty, _fs, proc) => vi.mocked(proc.process.createPty).mockImplementation(never),
      },
      {
        step: "waitForConnection",
        hang: (pty) => vi.mocked(pty.pty.waitForConnection).mockImplementation(never),
      },
      {
        step: "sendInput",
        hang: (pty) => vi.mocked(pty.pty.sendInput).mockImplementation(never),
      },
      {
        step: "the stderr download after exit",
        hang: (pty, fs) => {
          vi.mocked(fs.fs.downloadFile).mockImplementation(never);
          pty.resolveWait({ exitCode: 0 });
        },
      },
    ];

    for (const { step, hang } of hangs) {
      it(`settles with ExecTimeoutError when ${step} never returns`, async () => {
        vi.useFakeTimers();
        try {
          const ptyCtrl = fakePty();
          const fsCtrl = fakeFs();
          const procCtrl = fakeProcess(ptyCtrl);
          hang(ptyCtrl, fsCtrl, procCtrl);

          const handle = await startExecPty({
            process: procCtrl.process,
            fs: fsCtrl.fs,
            sessionIdPrefix: "p",
            cmd: ["true"],
            opts: { attachStdin: true, timeoutMs: 1_000 },
            random: deterministicRandom(),
          });
          let settled: unknown;
          handle.wait().then(
            (exit) => {
              settled = exit;
            },
            (e: unknown) => {
              settled = e;
            },
          );
          handle.stdin?.end();

          await vi.advanceTimersByTimeAsync(1_001);

          expect(settled).toBeInstanceOf(ExecTimeoutError);
        } finally {
          vi.useRealTimers();
        }
      });
    }
  });

  it("reports the exit code even when pty.disconnect() never returns", async () => {
    vi.useFakeTimers();
    try {
      const ptyCtrl = fakePty();
      vi.mocked(ptyCtrl.pty.disconnect).mockImplementation(() => new Promise<void>(() => {}));
      const fsCtrl = fakeFs();
      const procCtrl = fakeProcess(ptyCtrl);
      const handle = await startExecPty({
        process: procCtrl.process,
        fs: fsCtrl.fs,
        sessionIdPrefix: "p",
        cmd: ["true"],
        opts: { attachStdin: true },
        random: deterministicRandom(),
      });
      let settled: unknown;
      handle.wait().then(
        (exit) => {
          settled = exit;
        },
        (e: unknown) => {
          settled = e;
        },
      );
      handle.stdin?.end();
      await vi.advanceTimersByTimeAsync(0);
      ptyCtrl.resolveWait({ exitCode: 3 });

      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toEqual({ exitCode: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("output after the exit does not re-arm the idle deadline", async () => {
    vi.useFakeTimers();
    try {
      const ptyCtrl = fakePty();
      const fsCtrl = fakeFs();
      const procCtrl = fakeProcess(ptyCtrl);
      const handle = await startExecPty({
        process: procCtrl.process,
        fs: fsCtrl.fs,
        sessionIdPrefix: "p",
        cmd: ["true"],
        opts: { attachStdin: true, idleTimeoutMs: 5_000 },
        random: deterministicRandom(),
      });
      handle.stdin?.end();
      await vi.advanceTimersByTimeAsync(0);
      ptyCtrl.resolveWait({ exitCode: 0 });
      await expect(handle.wait()).resolves.toEqual({ exitCode: 0 });

      ptyCtrl.emitData("late\n");
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(5_001);
      expect(ptyCtrl.pty.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("an abnormal (1006) close", () => {
    async function startedPty(ptyCtrl: FakePtyControl, opts: { timeoutMs?: number } = {}) {
      const fsCtrl = fakeFs();
      const procCtrl = fakeProcess(ptyCtrl);
      const handle = await startExecPty({
        process: procCtrl.process,
        fs: fsCtrl.fs,
        sessionIdPrefix: "p",
        cmd: ["sleep", "999"],
        opts: { attachStdin: true, ...opts },
        random: deterministicRandom(),
      });
      handle.stdin?.end();
      return handle;
    }

    it("still settles when it comes while the command line is being sent", async () => {
      const ptyCtrl = fakePty();
      vi.mocked(ptyCtrl.pty.sendInput).mockImplementation(async () => {
        ptyCtrl.closeAbnormally();
      });
      // A `wait()` that never settles would leave only the deadline.
      const handle = await startedPty(ptyCtrl, { timeoutMs: 1_000 });
      const exited = await handle.exited;
      expect(exited.isErr() && exited.error.kind).toBe("no_exit_code");
    });

    it("kills the PTY, whose command may still be running", async () => {
      const ptyCtrl = fakePty();
      const handle = await startedPty(ptyCtrl);
      await vi.waitFor(() => expect(ptyCtrl.sendInputs).toHaveLength(1));
      ptyCtrl.closeAbnormally();
      const exited = await handle.exited;
      expect(exited.isErr() && exited.error.kind).toBe("no_exit_code");
      await handle.dispose();
      expect(ptyCtrl.pty.kill).toHaveBeenCalledTimes(1);
    });

    it("counts a kill that 404s as done", async () => {
      const ptyCtrl = fakePty();
      vi.mocked(ptyCtrl.pty.kill).mockRejectedValue(
        new DaytonaNotFoundError("PTY session not found", 404),
      );
      const handle = await startedPty(ptyCtrl);
      await vi.waitFor(() => expect(ptyCtrl.sendInputs).toHaveLength(1));
      ptyCtrl.closeAbnormally();
      await handle.exited;
      await handle.dispose();
      // A failed teardown would be retried by this second dispose.
      await handle.dispose();
      expect(ptyCtrl.pty.kill).toHaveBeenCalledTimes(1);
    });
  });

  it("calls pty.disconnect() on natural exit", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);

    const handle = await startExecPty({
      process: procCtrl.process,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: { attachStdin: true },
      random: deterministicRandom(),
    });
    handle.stdin?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    ptyCtrl.resolveWait({ exitCode: 0 });
    await handle.wait();

    expect(ptyCtrl.pty.disconnect).toHaveBeenCalledTimes(1);
  });

  it("fires the idle timer when no onData arrives within the bound", async () => {
    vi.useFakeTimers();
    try {
      const ptyCtrl = fakePty();
      const fsCtrl = fakeFs();
      const procCtrl = fakeProcess(ptyCtrl);

      const handle = await startExecPty({
        process: procCtrl.process,
        fs: fsCtrl.fs,
        sessionIdPrefix: "p",
        cmd: ["sleep", "999"],
        opts: { attachStdin: true, idleTimeoutMs: 5_000 },
        random: deterministicRandom(),
      });
      handle.stdin?.end();
      // Attach the catch handler before timers run so the rejection
      // never escapes as unhandled.
      const failure = handle.wait().catch((err: Error) => err);
      // Let the uploader + PTY-start microtasks drain.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // Now jump past the idle bound — no onData ever arrived.
      await vi.advanceTimersByTimeAsync(5_001);

      expect(ptyCtrl.killed).toBe(true);

      const err = await failure;
      if (!(err instanceof ExecTimeoutError)) {
        throw new Error(`expected ExecTimeoutError, got ${String(err)}`);
      }
      expect(err.kind).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires the total wall-clock timer even while onData is flowing", async () => {
    vi.useFakeTimers();
    try {
      const ptyCtrl = fakePty();
      const fsCtrl = fakeFs();
      const procCtrl = fakeProcess(ptyCtrl);

      const handle = await startExecPty({
        process: procCtrl.process,
        fs: fsCtrl.fs,
        sessionIdPrefix: "p",
        cmd: ["true"],
        opts: { attachStdin: true, timeoutMs: 1_000, idleTimeoutMs: 10_000 },
        random: deterministicRandom(),
      });
      handle.stdin?.end();
      const failure = handle.wait().catch((err: Error) => err);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // Keep idle timer alive with a steady chunk every 100ms — the
      // total timer must fire regardless.
      for (let t = 0; t < 1_001; t += 100) {
        ptyCtrl.emitData("x");
        await vi.advanceTimersByTimeAsync(100);
      }

      expect(ptyCtrl.killed).toBe(true);

      const err = await failure;
      if (!(err instanceof ExecTimeoutError)) {
        throw new Error(`expected ExecTimeoutError, got ${String(err)}`);
      }
      expect(err.kind).toBe("total");
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout exits even when the SDK's wait() never resolves after kill", async () => {
    // `kill()` sets no exit code, and a `wait()` can stay pending (a WS
    // that never closes, or one first called after a close). The deadline
    // settles the exec regardless: override kill so it does NOT resolve
    // wait.
    vi.useFakeTimers();
    try {
      const ptyCtrl = fakePty();
      vi.mocked(ptyCtrl.pty.kill).mockImplementation(async () => {
        ptyCtrl.killed = true;
        // No resolveWait() — mimic the SDK bug.
      });
      const fsCtrl = fakeFs();
      const procCtrl = fakeProcess(ptyCtrl);

      const handle = await startExecPty({
        process: procCtrl.process,
        fs: fsCtrl.fs,
        sessionIdPrefix: "p",
        cmd: ["sleep", "999"],
        opts: { attachStdin: true, timeoutMs: 1_000 },
        random: deterministicRandom(),
      });
      handle.stdin?.end();
      const failure = handle.wait().catch((err: Error) => err);
      // Flush microtasks so the start reaches `pty.sendInput`.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      // Fire the total timer; wait() never resolves, abort signal does.
      await vi.advanceTimersByTimeAsync(1_001);
      const err = await failure;
      if (!(err instanceof ExecTimeoutError)) {
        throw new Error(`expected ExecTimeoutError, got ${String(err)}`);
      }
      expect(err.kind).toBe("total");
      expect(ptyCtrl.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose() exits even when the SDK's wait() never resolves after kill", async () => {
    // Mirror of the timeout test, driving dispose() instead of the timer.
    const ptyCtrl = fakePty();
    vi.mocked(ptyCtrl.pty.kill).mockImplementation(async () => {
      ptyCtrl.killed = true;
    });
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);

    const handle = await startExecPty({
      process: procCtrl.process,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["sleep", "999"],
      opts: { attachStdin: true },
      random: deterministicRandom(),
    });
    handle.stdin?.end();
    // Let the start get past sendInput, so dispose kills a running PTY.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const failure = handle.wait().catch((err: Error) => err);
    await handle.dispose();
    expect(ptyCtrl.killed).toBe(true);
    const err = await failure;
    expect(err).toBeInstanceOf(ExecDisposedError);
  });

  it("dispose() before exit rejects wait() with ExecDisposedError and kills the PTY", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);

    const handle = await startExecPty({
      process: procCtrl.process,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["sleep", "999"],
      opts: { attachStdin: true },
      random: deterministicRandom(),
    });
    handle.stdin?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const failure = handle.wait().catch((err: Error) => err);
    await handle.dispose();
    expect(ptyCtrl.killed).toBe(true);

    const err = await failure;
    expect(err).toBeInstanceOf(ExecDisposedError);
  });

  it("dispose() mid-upload kills the PTY once it lands, doesn't run the exec to completion", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);

    // Hold the upload open so we can call dispose() after stdin.end()
    // has triggered the start but before createPty.
    let releaseUpload!: () => void;
    vi.mocked(fsCtrl.fs.uploadFile).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseUpload = resolve;
        }),
    );

    const handle = await startExecPty({
      process: procCtrl.process,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["sleep", "999"],
      opts: { attachStdin: true },
      random: deterministicRandom(),
    });
    handle.stdin?.end();
    // Let the start enter `await fs.uploadFile(...)`.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const failure = handle.wait().catch((err: Error) => err);
    // Dispose while the upload is still in flight; pty is still
    // undefined. The race the fix closes: after the upload releases,
    // the start must NOT create a PTY that then runs the exec.
    const disposed = handle.dispose();
    releaseUpload();
    await disposed;

    const err = await failure;
    expect(err).toBeInstanceOf(ExecDisposedError);
    // PTY was never created (disposed check fires before createPty).
    expect(procCtrl.process.createPty).not.toHaveBeenCalled();
    expect(ptyCtrl.killed).toBe(false);
    // sendInput never ran — no shell command was dispatched.
    expect(ptyCtrl.sendInputs).toHaveLength(0);
  });

  it("dispose() after createPty but before sendInput kills the new PTY", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();

    // Hold createPty open to control timing.
    let releaseCreate!: () => void;
    const proc = {
      createPty: vi.fn(async (options: { onData: (data: Uint8Array) => void | Promise<void> }) => {
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
        });
        ptyCtrl.emitData = (chunk: string | Uint8Array): void => {
          const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
          void options.onData(bytes);
        };
        return ptyCtrl.pty;
      }),
    } satisfies PtyProcessClient;

    const handle = await startExecPty({
      process: proc,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["sleep", "999"],
      opts: { attachStdin: true },
      random: deterministicRandom(),
    });
    handle.stdin?.end();
    // Let the start finish the upload and enter `await createPty(...)`.
    await vi.waitFor(() => expect(proc.createPty).toHaveBeenCalled());

    const failure = handle.wait().catch((err: Error) => err);
    let killedWhenDisposed: boolean | undefined;
    const disposed = handle.dispose().then(() => {
      killedWhenDisposed = ptyCtrl.killed;
    });
    // The settlement's teardown finds no PTY yet and finishes first.
    await vi.waitFor(() => expect(fsCtrl.deleted).toHaveLength(2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(killedWhenDisposed).toBeUndefined();

    releaseCreate();
    await disposed;

    expect(await failure).toBeInstanceOf(ExecDisposedError);
    // The late start's teardown killed the PTY before `dispose()` resolved.
    expect(killedWhenDisposed).toBe(true);
    expect(proc.createPty).toHaveBeenCalledTimes(1);
    expect(ptyCtrl.sendInputs).toHaveLength(0);
  });

  it("dispose() before stdin.end() rejects wait() with ExecDisposedError", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);

    const handle = await startExecPty({
      process: procCtrl.process,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: { attachStdin: true },
      random: deterministicRandom(),
    });
    // No stdin.end() — caller bails before sending any input.
    const failure = handle.wait().catch((err: Error) => err);
    await handle.dispose();

    const err = await failure;
    expect(err).toBeInstanceOf(ExecDisposedError);
    // PTY was never created — no kill to perform.
    expect(ptyCtrl.killed).toBe(false);
    // Nothing to upload either: the start never ran.
    expect(fsCtrl.uploaded).toHaveLength(0);
  });

  it("rejects opts.user (parity with the session-command path)", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);

    await expect(
      startExecPty({
        process: procCtrl.process,
        fs: fsCtrl.fs,
        sessionIdPrefix: "p",
        cmd: ["whoami"],
        opts: { attachStdin: true, user: "root" },
      }),
    ).rejects.toThrow(/opts.user is not supported/);
  });

  it("surfaces upload failures and skips PTY creation", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    vi.mocked(fsCtrl.fs.uploadFile).mockRejectedValueOnce(new Error("disk full"));
    const procCtrl = fakeProcess(ptyCtrl);

    const handle = await startExecPty({
      process: procCtrl.process,
      fs: fsCtrl.fs,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: { attachStdin: true },
      random: deterministicRandom(),
    });
    handle.stdin?.end();

    await expect(handle.wait()).rejects.toThrow(/disk full/);
  });
});
