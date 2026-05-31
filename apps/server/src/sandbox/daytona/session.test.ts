import { PassThrough, type Readable } from "node:stream";
import type { Sandbox as DaytonaSdkSandbox, Process } from "@daytonaio/sdk";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { DaytonaSessionState, ExecStreamingHandle } from "../index.js";
import { DaytonaSandboxSession } from "./session.js";

/**
 * Fake `Process` that controls the WS stream + exit-code fetch
 * end-to-end. We don't go through the real `startExecStreaming` here
 * because that's covered in `exec-streaming.test.ts` — instead we
 * stub-the-handle to drive `session.exec()`'s logic directly.
 */
function fakeProcess(opts: {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number;
  wsError?: Error;
}): Process {
  return {
    createSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    sendSessionCommandInput: vi.fn(async () => undefined),
    executeSessionCommand: vi.fn(async () => ({
      cmdId: "cmd-fake",
      output: "",
      stdout: "",
      stderr: "",
      exitCode: undefined,
    })),
    getSessionCommand: vi.fn(async () => ({
      id: "cmd-fake",
      command: "true",
      exitCode: opts.exitCode ?? 0,
    })),
    getSessionCommandLogs: vi.fn(
      async (
        _sid: string,
        _cid: string,
        onStdout: (c: string) => void,
        onStderr: (c: string) => void,
      ) => {
        if (opts.wsError) throw opts.wsError;
        await new Promise<void>((resolve) => {
          setImmediate(() => {
            for (const c of opts.stdoutChunks ?? []) onStdout(c);
            for (const c of opts.stderrChunks ?? []) onStderr(c);
            resolve();
          });
        });
      },
    ),
  } as unknown as Process;
}

function makeSession(proc: Process): DaytonaSandboxSession {
  return new DaytonaSandboxSession({
    state: {
      type: "daytona",
      taskId: "019d0000-0000-7000-8000-000000000aaa",
      sandboxId: "sb-1",
    } satisfies DaytonaSessionState,
    sdkSandbox: mock<DaytonaSdkSandbox>({ process: proc }),
  });
}

describe("DaytonaSandboxSession.exec", () => {
  it("returns a fully-typed ExecResult with stdout/stderr/exitCode/wallTime/truncated", async () => {
    const proc = fakeProcess({
      stdoutChunks: ["hello\n"],
      stderrChunks: ["warn\n"],
      exitCode: 0,
    });
    const session = makeSession(proc);
    const result = await session.exec(["echo", "hi"]);

    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("warn\n");
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.wallTimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof result.wallTimeSeconds).toBe("number");
  });

  it("propagates non-zero exit codes", async () => {
    const proc = fakeProcess({ stdoutChunks: [], exitCode: 42 });
    const session = makeSession(proc);
    const result = await session.exec(["false"]);
    expect(result.exitCode).toBe(42);
  });

  it("flags `truncated: true` when output exceeds the per-stream cap", async () => {
    // EXEC_BUFFER_LIMIT_BYTES is 1 MiB. Generate 1 MiB + 1 byte
    // worth of stdout to force the cap.
    const huge = "x".repeat(1024 * 1024 + 1);
    const proc = fakeProcess({ stdoutChunks: [huge], exitCode: 0 });
    const session = makeSession(proc);
    const result = await session.exec(["seq"]);
    expect(result.truncated).toBe(true);
    // Capped to 1 MiB exactly.
    expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it("does NOT crash on upstream stream `'error'` events (no-op listeners absorb them)", async () => {
    // Construct a fake handle whose stdout/stderr we control directly,
    // so we can fire `'error'` to mimic an upstream `destroy(err)`
    // before / during buffering. Without no-op `'error'` listeners on
    // those streams, Node's unhandledError would crash the worker.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const wait = vi.fn(async () => ({ exitCode: 0 }));
    const dispose = vi.fn(async () => undefined);
    const handle: ExecStreamingHandle = {
      stdout: stdout as Readable,
      stderr: stderr as Readable,
      wait,
      dispose,
    };
    // Replace the underlying `execStreaming` so we can hand back our
    // controlled handle.
    const session = makeSession(fakeProcess({ exitCode: 0 }));
    const execStreamingMock = vi.spyOn(session, "execStreaming").mockResolvedValue(handle);

    // Schedule an `'error'` emission on stdout AFTER `exec` has
    // attached its listeners — the absence of an absorber here would
    // turn the emission into an uncaught exception that nukes the
    // process. With the fix, both the data and error listeners are
    // attached; the error event is silently absorbed and `wait()`
    // settles cleanly.
    setImmediate(() => {
      stdout.destroy(new Error("upstream gone"));
      stderr.destroy(new Error("upstream gone"));
    });

    const result = await session.exec(["true"]);
    expect(result.exitCode).toBe(0);
    expect(execStreamingMock).toHaveBeenCalled();
  });

  it("calls `dispose()` in `finally` after `wait()` resolves (cleanup of per-call session)", async () => {
    const proc = fakeProcess({ exitCode: 0 });
    const session = makeSession(proc);
    const dispose = vi.fn(async () => undefined);
    const fakeHandle: ExecStreamingHandle = {
      stdout: new PassThrough() as Readable,
      stderr: new PassThrough() as Readable,
      wait: vi.fn(async () => ({ exitCode: 0 })),
      dispose,
    };
    vi.spyOn(session, "execStreaming").mockResolvedValue(fakeHandle);

    await session.exec(["echo"]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("calls `dispose()` even when `wait()` rejects (mid-stream upstream failure)", async () => {
    // The defence-in-depth half of the cleanup contract: if the
    // streaming wrapper's own session-cleanup somehow raced or threw
    // before deleting, the session-level finally is the safety net.
    const session = makeSession(fakeProcess({ exitCode: 0 }));
    const dispose = vi.fn(async () => undefined);
    const fakeHandle: ExecStreamingHandle = {
      stdout: new PassThrough() as Readable,
      stderr: new PassThrough() as Readable,
      wait: vi.fn(async () => {
        throw new Error("upstream WS dropped");
      }),
      dispose,
    };
    // Attach error listeners on the streams to mirror what `exec()`
    // does — otherwise the test setup itself crashes on stream destroy.
    vi.spyOn(session, "execStreaming").mockResolvedValue(fakeHandle);

    await expect(session.exec(["true"])).rejects.toThrow(/upstream WS dropped/);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("execStreaming creates a unique session per call (per-taskId prefix + random suffix)", async () => {
    const proc = fakeProcess({ stdoutChunks: [], exitCode: 0 });
    const session = makeSession(proc);
    const a = await session.execStreaming(["echo", "a"]);
    const b = await session.execStreaming(["echo", "b"]);
    await Promise.all([a.wait(), b.wait()]);

    const createSessionMock = vi.mocked(proc.createSession);
    const sids = createSessionMock.mock.calls.map((c) => c[0]);
    expect(sids).toHaveLength(2);
    expect(sids[0]).not.toBe(sids[1]);
    // Prefix is `cogmo-<first 12 chars of taskId>`. The taskId
    // `019d0000-0000-7000-...` keeps the dashes, so the first 12
    // chars include them: `019d0000-000`.
    expect(sids[0]).toMatch(/^cogmo-019d0000-000-/);
    expect(sids[1]).toMatch(/^cogmo-019d0000-000-/);
  });

  it("execStreaming threads the constructor-supplied random into the session-id suffix", async () => {
    // Pins the wiring `DaytonaSandboxClient → DaytonaSandboxSession →
    // startExecStreaming` for the `random` injection slot. A future
    // refactor that breaks the plumbing (e.g. drops the conditional-
    // spread that forwards `random` from session to exec-streaming)
    // would silently fall back to `randomUUID` and surface only as a
    // record/replay drift in the conformance suite — which is skipped
    // until fixtures land.
    const proc = fakeProcess({ stdoutChunks: [], exitCode: 0 });
    let seq = 0;
    const session = new DaytonaSandboxSession({
      state: {
        type: "daytona",
        taskId: "019d0000-0000-7000-8000-000000000aaa",
        sandboxId: "sb-1",
      } satisfies DaytonaSessionState,
      sdkSandbox: mock<DaytonaSdkSandbox>({ process: proc }),
      random: () => `pinned-${++seq}`,
    });

    const a = await session.execStreaming(["echo", "a"]);
    const b = await session.execStreaming(["echo", "b"]);
    await Promise.all([a.wait(), b.wait()]);

    const sids = vi.mocked(proc.createSession).mock.calls.map((c) => c[0]);
    expect(sids).toEqual(["cogmo-019d0000-000-pinned-1", "cogmo-019d0000-000-pinned-2"]);
  });
});
