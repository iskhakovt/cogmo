import type { PtyHandle, PtyResult } from "@daytonaio/sdk";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { ExecTimeoutError } from "../index.js";
import { type PtyFileSystemClient, type PtyProcessClient, startExecPty } from "./exec-pty.js";
import { DisposedError } from "./exec-streaming.js";

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

  const pty = mock<PtyHandle>();
  const ctrl: FakePtyControl = {
    pty,
    emitData: () => {
      throw new Error("emitData called before onData attached");
    },
    resolveWait,
    rejectWait,
    sendInputs: [],
    killed: false,
    disconnected: false,
  };

  pty.waitForConnection.mockResolvedValue();
  pty.sendInput.mockImplementation(async (data: string | Uint8Array) => {
    ctrl.sendInputs.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  });
  pty.wait.mockImplementation(() => waitPromise);
  pty.kill.mockImplementation(async () => {
    ctrl.killed = true;
    // PtyHandle.kill resolves the wait without populating exitCode —
    // the runner maps that to its timeout/dispose sentinel branches
    // when a flag is set, or to a missing-exit-code error otherwise.
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
      // No `handle.stdin.end()` — the IIFE is parked on the finish event.
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
      // checkAborted() runs after the slow upload completes — createPty
      // never runs.
      expect(procCtrl.process.createPty).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
    // Real-world failure mode: SDK's PtyHandle.wait() polls _exitCode
    // every 100ms; kill() only invokes an HTTP RPC, doesn't set the
    // exit code. On WS close code 1006 (abnormal) with empty reason,
    // wait() loops forever even after kill returns. Cogmo's abort signal
    // must let the timer path exit deterministically without waiting for
    // the SDK to settle. Mirror that here: override kill so it does NOT
    // resolve wait.
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
      // Flush microtasks so startPty progresses to `pty.sendInput`.
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
    // Let startPty get past sendInput so dispose hits the post-kill path.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const failure = handle.wait().catch((err: Error) => err);
    await handle.dispose();
    expect(ptyCtrl.killed).toBe(true);
    const err = await failure;
    expect(err).toBeInstanceOf(DisposedError);
  });

  it("dispose() before exit rejects wait() with DisposedError and kills the PTY", async () => {
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
    expect(err).toBeInstanceOf(DisposedError);
  });

  it("dispose() mid-upload kills the PTY once it lands, doesn't run the exec to completion", async () => {
    const ptyCtrl = fakePty();
    const fsCtrl = fakeFs();
    const procCtrl = fakeProcess(ptyCtrl);

    // Hold the upload open so we can call dispose() after stdin.end()
    // has triggered startPty but before createPty has been awaited.
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
    // Let startPty enter `await fs.uploadFile(...)`.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const failure = handle.wait().catch((err: Error) => err);
    // Dispose while the upload is still in flight; pty is still
    // undefined. The race the fix closes: after the upload releases,
    // startPty must NOT create a PTY that then runs the exec.
    const disposed = handle.dispose();
    releaseUpload();
    await disposed;

    const err = await failure;
    expect(err).toBeInstanceOf(DisposedError);
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
    // Let startPty finish upload and enter `await createPty(...)`.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const failure = handle.wait().catch((err: Error) => err);
    const disposed = handle.dispose();
    releaseCreate();
    await disposed;

    const err = await failure;
    expect(err).toBeInstanceOf(DisposedError);
    // PTY was created, then immediately killed by the post-createPty
    // disposed check in startPty.
    expect(proc.createPty).toHaveBeenCalledTimes(1);
    expect(ptyCtrl.killed).toBe(true);
    expect(ptyCtrl.sendInputs).toHaveLength(0);
  });

  it("dispose() before stdin.end() rejects wait() with DisposedError", async () => {
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
    expect(err).toBeInstanceOf(DisposedError);
    // PTY was never created — no kill to perform.
    expect(ptyCtrl.killed).toBe(false);
    // Nothing to upload either, since startPty was bypassed.
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
