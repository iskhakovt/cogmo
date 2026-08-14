import { DaytonaNotFoundError, type Process } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import { ExecTimeoutError } from "../index.js";
import { DisposedError, startExecStreaming } from "./exec-streaming.js";

/**
 * Minimal `Process` stub. Each test scripts its own behaviour via the
 * factory's `script` argument; the rest are vi.fn() spies that record
 * the call shape.
 */
interface Script {
  /** Resolve the WS log promise with optional pre-emit chunks. */
  wsResolve?: { stdoutChunks?: string[]; stderrChunks?: string[] };
  /** Or reject the WS promise (e.g. simulating dispose-induced teardown). */
  wsReject?: Error;
  /** Exit code reported by `getSessionCommand` after the WS settles. */
  exitCode?: number;
  /** `executeSessionCommand` returns this cmdId. */
  cmdId?: string;
}

function fakeProcess(script: Script): Process {
  const createSession = vi.fn(async () => undefined);
  // `getSessionCommand(sid)` 404s after `deleteSession(sid)` —
  // mirrors live Daytona. Without this invariant, the unit suite
  // can't catch lifecycle-ordering regressions on the success path.
  const deletedSessions = new Set<string>();
  const deleteSession = vi.fn(async (sid: string) => {
    deletedSessions.add(sid);
    return undefined;
  });
  const executeSessionCommand = vi.fn(async () => ({
    cmdId: script.cmdId ?? "cmd-fake",
    output: "",
    stdout: "",
    stderr: "",
    exitCode: undefined as number | undefined,
  }));
  const getSessionCommand = vi.fn(async (sid: string) => {
    if (deletedSessions.has(sid)) {
      throw new DaytonaNotFoundError("session not found", 404);
    }
    return {
      id: "cmd-fake",
      command: "true",
      exitCode: script.exitCode ?? 0,
    };
  });
  const getSessionCommandLogs = vi.fn(
    async (
      _sid: string,
      _cid: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ) => {
      if (script.wsReject) {
        throw script.wsReject;
      }
      // Emit chunks asynchronously to mimic a real WS stream — same
      // shape consumers see in production.
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          for (const c of script.wsResolve?.stdoutChunks ?? []) onStdout(c);
          for (const c of script.wsResolve?.stderrChunks ?? []) onStderr(c);
          resolve();
        });
      });
    },
  );

  return {
    createSession,
    deleteSession,
    executeSessionCommand,
    getSessionCommand,
    getSessionCommandLogs,
    // The rest of Process is unused by exec-streaming.
  } as unknown as Process;
}

describe("startExecStreaming", () => {
  it("creates a fresh session, executes async, streams chunks to stdout/stderr", async () => {
    const proc = fakeProcess({
      wsResolve: { stdoutChunks: ["hello\n"], stderrChunks: ["warn\n"] },
      exitCode: 0,
    });
    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "test",
      cmd: ["echo", "hi"],
      opts: {},
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    handle.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    handle.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    const { exitCode } = await handle.wait();
    expect(exitCode).toBe(0);
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toBe("hello\n");
    expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("warn\n");
  });

  it("creates a unique session per call (per-call id, not reused)", async () => {
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["echo"],
      opts: {},
    }).then((h) => h.wait());
    await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["echo"],
      opts: {},
    }).then((h) => h.wait());

    const createSessionMock = vi.mocked(proc.createSession);
    const sessionIds = createSessionMock.mock.calls.map((c) => c[0]);
    expect(sessionIds).toHaveLength(2);
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
  });

  it("quotes argv via single-quote shell escaping (defends against injection)", async () => {
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["echo", "$(rm -rf /)"],
      opts: {},
    }).then((h) => h.wait());
    const exec = vi.mocked(proc.executeSessionCommand);
    const command = exec.mock.calls[0]?.[1].command;
    // The dangerous payload is wrapped in literal single quotes — bash
    // never parses `$(...)` inside single quotes.
    expect(command).toContain("'$(rm -rf /)'");
    expect(command).not.toContain('"$(');
  });

  it("threads workingDir + env into the shell command", async () => {
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["pwd"],
      opts: { workingDir: "/workspace", env: { GIT_ASKPASS: "/helper" } },
    }).then((h) => h.wait());
    const exec = vi.mocked(proc.executeSessionCommand);
    const command = exec.mock.calls[0]?.[1].command;
    expect(command).toMatch(/^cd '\/workspace' &&/);
    expect(command).toContain("env 'GIT_ASKPASS'='/helper'");
  });

  it("emits no env prefix when env is an empty record", async () => {
    // Defends a subtle inversion: an `env: {}` opt arriving from a
    // non-env-aware caller must NOT synthesize a bare `env <argv>...`
    // (which on most coreutils strips the inherited env, breaking
    // PATH-dependent commands). Builder gates the prefix on
    // `Object.keys(opts.env).length > 0` — this regression test
    // pins the gate.
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["pwd"],
      opts: { env: {} },
    }).then((h) => h.wait());
    const exec = vi.mocked(proc.executeSessionCommand);
    const command = exec.mock.calls[0]?.[1].command;
    // The whole command should be `'pwd'` — no leading `env `, no
    // leading `cd ` (workingDir omitted), and crucially no `exec` —
    // bash's `exec` builtin replaces the shell, and Daytona's session
    // completion detection waits for the shell to exit. Running as a
    // child of bash gives the shell something to exit from.
    expect(command).toBe("'pwd'");
  });

  it("never emits bash's exec builtin (would prevent Daytona session completion)", async () => {
    // Daytona [#2513]: session-command completion fires on the shell
    // exit. `exec <argv>` replaces the shell with the target binary,
    // so when the binary completes the session never reports
    // completion and the WS log-stream stays open until something
    // external tears it down (idleTimeoutMs, deleteSession). Regression
    // pin: the emitted command must invoke the target as a child of
    // bash, never via the `exec` builtin.
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["git", "checkout", "-B", "feature"],
      opts: { workingDir: "/workspace" },
    }).then((h) => h.wait());
    const exec = vi.mocked(proc.executeSessionCommand);
    const command = exec.mock.calls[0]?.[1].command;
    expect(command).not.toMatch(/\bexec\b/);
    expect(command).toBe("cd '/workspace' && 'git' 'checkout' '-B' 'feature'");
  });

  it("dispose() calls deleteSession and rejects wait() with DisposedError", async () => {
    // Per the `ExecStreamingHandle` contract, `wait()` must REJECT
    // (not resolve with a sentinel exit code) after `dispose()` so
    // backend-agnostic consumers can branch on the dispose path
    // explicitly. Mirrors the Local-Docker backend's behaviour.
    let stdoutCb: ((c: string) => void) | undefined;
    const proc = fakeProcess({ wsReject: new Error("ws closed") });
    let resolveWs: (() => void) | undefined;
    let rejectWs: ((err: Error) => void) | undefined;
    vi.mocked(proc.getSessionCommandLogs).mockImplementation(
      (_sid: string, _cid: string, onStdout: (c: string) => void) => {
        stdoutCb = onStdout;
        return new Promise<void>((resolve, reject) => {
          resolveWs = resolve;
          rejectWs = reject;
        });
      },
    );
    vi.mocked(proc.deleteSession).mockImplementation(async () => {
      // Mimic real Daytona: deleteSession tears down the WS, which
      // causes the still-pending logs Promise to reject.
      rejectWs?.(new Error("session deleted"));
      void resolveWs;
      void stdoutCb;
    });

    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["sleep", "infinity"],
      opts: {},
    });
    // Suppress the (expected) unhandled-rejection from the wait
    // promise — caller will await it explicitly below.
    handle.wait().catch(() => undefined);

    const TIMEOUT_MS = 500;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
    });
    const winner = await Promise.race([handle.dispose().then(() => "disposed" as const), timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    expect(winner).toBe("disposed");
    expect(proc.deleteSession).toHaveBeenCalled();
    await expect(handle.wait()).rejects.toBeInstanceOf(DisposedError);
  });

  it("rejects opts.user as Phase-3a-unsupported (matches LocalDocker silently honoring; loud diff is better)", async () => {
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    await expect(
      startExecStreaming({
        process: proc,
        sessionIdPrefix: "p",
        cmd: ["whoami"],
        opts: { user: "claude" },
      }),
    ).rejects.toThrow(/opts\.user is not supported in Phase 3a/);
    // No session created — the rejection must fire before the
    // `createSession` call.
    expect(proc.createSession).not.toHaveBeenCalled();
  });

  it("dispose() racing in-flight getSessionCommand rejects with DisposedError, not the raw 404", async () => {
    // Race window: WS resolves naturally, the success-path
    // `getSessionCommand` is in flight, consumer calls dispose() which
    // deletes the session. The in-flight fetch then 404s. Per the
    // ExecStreamingHandle contract, consumers branching on outcome
    // must see `DisposedError`, not the raw SDK NotFound. Mirrors the
    // .catch branch's mapping.
    const proc = fakeProcess({ wsResolve: {} });
    let resolveFetch!: (v: Awaited<ReturnType<Process["getSessionCommand"]>>) => void;
    let rejectFetch!: (e: Error) => void;
    const fetchGate = new Promise<Awaited<ReturnType<Process["getSessionCommand"]>>>(
      (resolve, reject) => {
        resolveFetch = resolve;
        rejectFetch = reject;
      },
    );
    vi.mocked(proc.getSessionCommand).mockImplementation(() => fetchGate);

    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: {},
    });
    handle.stdout.on("data", () => {});

    // Let .then() reach the await on getSessionCommand. One microtask
    // tick is enough to drain the synchronous prelude.
    await new Promise<void>((r) => setImmediate(r));

    // Dispose mid-fetch — sets disposed=true and deletes the session.
    const disposing = handle.dispose();
    // Simulate Daytona's 404 surfacing through the in-flight fetch.
    rejectFetch(new DaytonaNotFoundError("session not found", 404));
    await disposing;

    await expect(handle.wait()).rejects.toBeInstanceOf(DisposedError);
    // Suppress the unused `resolveFetch` lint signal — kept for symmetry
    // so readers see both halves of the gate.
    void resolveFetch;
  });

  it("rejects wait() when getSessionCommand throws post-WS-resolve (network blip on exit-code fetch)", async () => {
    // Race window: WS closes naturally, then the follow-up
    // `getSessionCommand` HTTP fetch fails (transient daemon error,
    // rate limit, network drop). The natural-exit branch in
    // exec-streaming.ts catches the throw, runs `cleanupSession`, and
    // forwards the error to wait()'s reject — consumers must NOT see
    // a phantom exitCode=0.
    const proc = fakeProcess({ wsResolve: {} });
    const fetchErr = new Error("503 Service Unavailable");
    vi.mocked(proc.getSessionCommand).mockRejectedValue(fetchErr);
    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: {},
    });
    await expect(handle.wait()).rejects.toBe(fetchErr);
    // Session cleanup must still fire on this path so per-call
    // sessions don't leak when the exit-code fetch fails.
    expect(proc.deleteSession).toHaveBeenCalled();
  });

  it("rejects wait() when natural-exit returns no exit code (don't mask 'unknown' as 0)", async () => {
    const proc = fakeProcess({ wsResolve: {} });
    // Override `getSessionCommand` to return no exitCode — mimics
    // the rare server-side race where the WS closes but the command
    // record hasn't durably captured the exit status yet.
    // Omit exitCode (rather than setting it to undefined) — exactOptionalPropertyTypes
    // forbids `= undefined` for an optional property, and the omission is
    // exactly the runtime shape we're modelling: server-side race where the
    // command record hasn't durably captured the exit status yet.
    vi.mocked(proc.getSessionCommand).mockResolvedValue({
      id: "cmd-fake",
      command: "true",
    });
    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: {},
    });
    await expect(handle.wait()).rejects.toThrow(/reported no exit code/);
  });

  it("dispose() is idempotent — second call is a no-op", async () => {
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: {},
    });
    await handle.wait();
    await handle.dispose();
    await handle.dispose();
    // deleteSession called at most once via dispose (the natural exit
    // path doesn't call it).
    const calls = vi.mocked(proc.deleteSession).mock.calls.length;
    expect(calls).toBeLessThanOrEqual(1);
  });

  it("rejects attachStdin (must be routed to the PTY backend)", async () => {
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    await expect(
      startExecStreaming({
        process: proc,
        sessionIdPrefix: "p",
        cmd: ["cat"],
        opts: { attachStdin: true },
      }),
    ).rejects.toThrow(/attachStdin must be routed to the PTY backend/);
  });

  it("throws + tears down the session if executeSessionCommand returns no cmdId", async () => {
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    vi.mocked(proc.executeSessionCommand).mockResolvedValue({
      cmdId: "",
    });
    await expect(
      startExecStreaming({
        process: proc,
        sessionIdPrefix: "p",
        cmd: ["echo"],
        opts: {},
      }),
    ).rejects.toThrow(/no cmdId/);
    expect(proc.deleteSession).toHaveBeenCalled();
  });

  it("tears down the session if executeSessionCommand throws (network blip / daemon error)", async () => {
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    vi.mocked(proc.executeSessionCommand).mockRejectedValue(new Error("network down"));
    await expect(
      startExecStreaming({
        process: proc,
        sessionIdPrefix: "p",
        cmd: ["echo"],
        opts: {},
      }),
    ).rejects.toThrow(/network down/);
    expect(proc.deleteSession).toHaveBeenCalled();
  });

  it("deletes the session on natural success — no leak across exec calls", async () => {
    const proc = fakeProcess({ wsResolve: { stdoutChunks: ["ok\n"] }, exitCode: 0 });
    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: {},
    });
    handle.stdout.on("data", () => {});
    await handle.wait();
    // Wait one tick for the cleanup chained off the WS resolve.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(proc.deleteSession).toHaveBeenCalledTimes(1);
  });

  it("natural-success lifecycle ordering: getSessionCommand fires BEFORE deleteSession", async () => {
    // `getSessionCommand` 404s once the session is deleted, so any
    // cleanup-before-fetch ordering breaks every successful exec
    // call. Pin the relative order on the success path.
    const order: string[] = [];
    const proc = fakeProcess({ wsResolve: { stdoutChunks: ["ok\n"] }, exitCode: 7 });
    vi.mocked(proc.getSessionCommand).mockImplementation(async () => {
      order.push("getSessionCommand");
      return { id: "cmd-fake", command: "true", exitCode: 7 };
    });
    vi.mocked(proc.deleteSession).mockImplementation(async () => {
      order.push("deleteSession");
      return undefined;
    });

    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: {},
    });
    handle.stdout.on("data", () => {});
    const result = await handle.wait();

    expect(result.exitCode).toBe(7);
    expect(order).toEqual(["getSessionCommand", "deleteSession"]);
  });

  it("fake contract: getSessionCommand(sid) 404s after deleteSession(sid)", async () => {
    // Pins the fake's invariant — the SUT's success-path ordering
    // test depends on this. Verified separately so a fake-side
    // regression doesn't silently disable the SUT-side test.
    const proc = fakeProcess({ exitCode: 0 });
    await proc.deleteSession("sid-x");
    await expect(proc.getSessionCommand("sid-x", "cmd-x")).rejects.toBeInstanceOf(
      DaytonaNotFoundError,
    );
  });

  it("upstream WS error rejects wait() AND deletes the session (no leak on real failure)", async () => {
    const proc = fakeProcess({
      wsReject: new Error("transient WS drop"),
      exitCode: 0,
    });
    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: {},
    });
    // Attach an `'error'` absorber on the demuxed streams — the
    // wrapper calls `stream.destroy(err)` on a real error, which
    // would crash the test if no listener was attached. Production
    // consumers (DaytonaSandboxSession.exec) attach a no-op error
    // listener for this exact reason.
    handle.stdout.on("error", () => {});
    handle.stderr.on("error", () => {});
    await expect(handle.wait()).rejects.toThrow(/transient WS drop/);
    // Wait for the cleanup chained off the WS rejection.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(proc.deleteSession).toHaveBeenCalledTimes(1);
  });

  it("session cleanup is idempotent — dispose after natural exit doesn't double-delete", async () => {
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: {},
    });
    await handle.wait();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await handle.dispose();
    expect(proc.deleteSession).toHaveBeenCalledTimes(1);
  });

  it("retries deleteSession on the next call when the first attempt failed", async () => {
    // Sequential-call retry: natural-exit cleanup fails, dispose
    // fires its own attempt that succeeds.
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    let attempt = 0;
    vi.mocked(proc.deleteSession).mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient daemon error");
    });

    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: {},
    });
    await handle.wait();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(proc.deleteSession).toHaveBeenCalledTimes(1);

    await handle.dispose();
    expect(proc.deleteSession).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers don't return without retrying when the first attempt fails", async () => {
    // The leak scenario: dispose() fires deleteSession (caller A);
    // while A is in flight, the WS rejects for an unrelated reason
    // (idle timeout, server blip), triggering the WS-error cleanup
    // path (caller B). B awaits A's `inFlight`. A fails. Without
    // the retry-on-failure loop, B returns — session leaks. The
    // loop has B fall through and fire its own attempt.
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    const attempts: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
    vi.mocked(proc.deleteSession).mockImplementation(() => {
      return new Promise<void>((resolve, reject) => {
        attempts.push({ resolve, reject });
      });
    });

    // Hold the WS open so we orchestrate the race manually.
    let rejectWs: ((err: Error) => void) | undefined;
    vi.mocked(proc.getSessionCommandLogs).mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWs = reject;
        }),
    );

    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["sleep", "infinity"],
      opts: {},
    });
    // Suppress the (eventual) wait() rejection — we don't await it.
    handle.wait().catch(() => undefined);

    // dispose() fires cleanupSession (caller A).
    const disposeP = handle.dispose();
    await vi.waitUntil(() => attempts.length === 1, { timeout: 200 });

    // While A is in flight, the WS rejects — the WS-error path
    // chains its own cleanupSession call (caller B). B enters the
    // `while (inFlight)` loop, awaiting A.
    rejectWs?.(new Error("ws dropped"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // A fails.
    attempts[0]?.reject(new Error("transient delete failure"));

    // Without the retry loop, B would return here without firing a
    // second deleteSession. With the loop, B falls through and fires
    // its own attempt → attempts.length becomes 2.
    await vi.waitUntil(() => attempts.length === 2, { timeout: 500 });
    attempts[1]?.resolve();

    await disposeP;
    expect(proc.deleteSession).toHaveBeenCalledTimes(2);
  });

  // ── Wall-clock and idle timeouts ──
  //
  // The wedge that motivated these (4-day stuck task on run id
  // `01KRM7A886F293XVTJPVB9CZ91`) was a `getSessionCommandLogs` WS that
  // held open silently — no `onStdout`, no `onStderr`, no close. Without
  // a timeout, `await handle.wait()` blocks forever. These tests model
  // that exact shape (WS opens, never resolves, no chunks emitted) and
  // assert the cap settles `wait()` with `ExecTimeoutError` + runs
  // `deleteSession` (the Daytona [#2510] recommended cleanup path).
  it("timeoutMs: total wall-clock cap fires when WS holds open silently, cleanup runs, wait() rejects with ExecTimeoutError(kind='total')", async () => {
    let resolveWs: (() => void) | undefined;
    const proc = fakeProcess({ wsResolve: {} });
    // Override the WS to a held-open promise — never resolves on its
    // own, mimicking the wedge. `deleteSession` is what closes it.
    vi.mocked(proc.getSessionCommandLogs).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWs = resolve;
        }),
    );
    vi.mocked(proc.deleteSession).mockImplementation(async () => {
      // Mimic real Daytona — deleteSession tears down the WS, closing
      // the still-open logs promise. Resolve (rather than reject)
      // matches what Daytona's SDK does on the success path of a
      // killed session — and exercises the `.then(timedOut ? reject)`
      // branch in exec-streaming.ts.
      resolveWs?.();
    });

    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["sleep", "infinity"],
      opts: { timeoutMs: 50 },
    });
    handle.stdout.on("error", () => {});
    handle.stderr.on("error", () => {});

    const start = Date.now();
    const err = await handle.wait().catch((e: Error) => e);
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(ExecTimeoutError);
    expect((err as ExecTimeoutError).kind).toBe("total");
    expect((err as ExecTimeoutError).timeoutMs).toBe(50);
    // Sanity: actually waited at least the timeout (no instant fire),
    // and didn't block for 30s by accident.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2_000);
    // The cleanup runs the same `deleteSession` `dispose()` would —
    // Daytona [#2510]'s prescribed explicit-cleanup path.
    expect(proc.deleteSession).toHaveBeenCalled();
  });

  it("idleTimeoutMs: idle watchdog fires when WS holds open with no chunks for the configured window", async () => {
    let resolveWs: (() => void) | undefined;
    const proc = fakeProcess({ wsResolve: {} });
    vi.mocked(proc.getSessionCommandLogs).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWs = resolve;
        }),
    );
    vi.mocked(proc.deleteSession).mockImplementation(async () => {
      resolveWs?.();
    });

    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["claude", "-p"],
      opts: { idleTimeoutMs: 50 },
    });
    handle.stdout.on("error", () => {});
    handle.stderr.on("error", () => {});

    const err = await handle.wait().catch((e: Error) => e);
    expect(err).toBeInstanceOf(ExecTimeoutError);
    expect((err as ExecTimeoutError).kind).toBe("idle");
    expect(proc.deleteSession).toHaveBeenCalled();
  });

  it("idleTimeoutMs: chunk arrival resets the watchdog — exec completes when WS keeps emitting under the idle window", async () => {
    let resolveWs: (() => void) | undefined;
    let onStdoutCb: ((c: string) => void) | undefined;
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    vi.mocked(proc.getSessionCommandLogs).mockImplementation(
      (_sid: string, _cid: string, onStdout: (c: string) => void) => {
        onStdoutCb = onStdout;
        return new Promise<void>((resolve) => {
          resolveWs = resolve;
        });
      },
    );

    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["yes"],
      opts: { idleTimeoutMs: 100 },
    });
    handle.stdout.on("data", () => {});
    handle.stderr.on("data", () => {});

    // Drip-feed chunks under the idle interval. After 4 ticks the
    // total elapsed time exceeds the 100ms idle cap, but no single
    // gap exceeds it — the watchdog must NOT fire.
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      onStdoutCb?.("tick\n");
    }
    // Now close the WS cleanly, simulating natural exit.
    resolveWs?.();

    const { exitCode } = await handle.wait();
    expect(exitCode).toBe(0);
    // Cleanup still runs on natural-exit.
    expect(proc.deleteSession).toHaveBeenCalled();
  });

  it("natural-exit clears timers — a slow exec that finishes under the cap doesn't accidentally fire the timeout after", async () => {
    // Regression guard: if `clearTimers` weren't called on the
    // `.then(success)` path, the total/idle timers could fire after
    // `wait()` already resolved, leaving a stray `deleteSession` call
    // (and an extra rejection trying to settle a resolved promise).
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["true"],
      opts: { timeoutMs: 200, idleTimeoutMs: 200 },
    });
    handle.stdout.on("data", () => {});
    handle.stderr.on("data", () => {});
    const { exitCode } = await handle.wait();
    expect(exitCode).toBe(0);
    // Wait longer than the timers — they must NOT fire.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(proc.deleteSession).toHaveBeenCalledTimes(1);
  });
});
