import type { Process } from "@daytonaio/sdk";
import { describe, expect, it, vi } from "vitest";
import { startExecStreaming } from "./exec-streaming.js";

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
  const deleteSession = vi.fn(async () => undefined);
  const sendSessionCommandInput = vi.fn(async () => undefined);
  const executeSessionCommand = vi.fn(async () => ({
    cmdId: script.cmdId ?? "cmd-fake",
    output: "",
    stdout: "",
    stderr: "",
    exitCode: undefined as number | undefined,
  }));
  const getSessionCommand = vi.fn(async () => ({
    id: "cmd-fake",
    command: "true",
    exitCode: script.exitCode ?? 0,
  }));
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
    sendSessionCommandInput,
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

    const createSessionMock = proc.createSession as unknown as ReturnType<typeof vi.fn>;
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
    const exec = proc.executeSessionCommand as unknown as ReturnType<typeof vi.fn>;
    const command = exec.mock.calls[0]?.[1].command as string;
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
    const exec = proc.executeSessionCommand as unknown as ReturnType<typeof vi.fn>;
    const command = exec.mock.calls[0]?.[1].command as string;
    expect(command).toMatch(/^cd '\/workspace' &&/);
    expect(command).toContain("env 'GIT_ASKPASS'='/helper'");
  });

  it("dispose() calls deleteSession and resolves wait() with exit code 137", async () => {
    let stdoutCb: ((c: string) => void) | undefined;
    const proc = fakeProcess({ wsReject: new Error("ws closed") });
    // Override getSessionCommandLogs to hold open until disposed
    let resolveWs: (() => void) | undefined;
    let rejectWs: ((err: Error) => void) | undefined;
    (proc.getSessionCommandLogs as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_sid: string, _cid: string, onStdout: (c: string) => void) => {
        stdoutCb = onStdout;
        return new Promise<void>((resolve, reject) => {
          resolveWs = resolve;
          rejectWs = reject;
        });
      },
    );
    (proc.deleteSession as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
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

    const TIMEOUT_MS = 500;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
    });
    const winner = await Promise.race([handle.dispose().then(() => "disposed" as const), timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    expect(winner).toBe("disposed");
    expect(proc.deleteSession).toHaveBeenCalled();
    const { exitCode } = await handle.wait();
    expect(exitCode).toBe(137);
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
    const calls = (proc.deleteSession as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBeLessThanOrEqual(1);
  });

  it("attachStdin: true exposes a Writable that calls sendSessionCommandInput", async () => {
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    const handle = await startExecStreaming({
      process: proc,
      sessionIdPrefix: "p",
      cmd: ["cat"],
      opts: { attachStdin: true },
    });
    expect(handle.stdin).toBeDefined();
    handle.stdin?.write("hello");
    handle.stdin?.write("world");
    // Synchronous after write — wait one tick so the underlying
    // promise-based send flushes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const sends = (
      proc.sendSessionCommandInput as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[2]);
    expect(sends).toContain("hello");
    expect(sends).toContain("world");
    await handle.wait();
  });

  it("throws + tears down the session if executeSessionCommand returns no cmdId", async () => {
    const proc = fakeProcess({ wsResolve: {}, exitCode: 0 });
    (proc.executeSessionCommand as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    (proc.executeSessionCommand as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down"),
    );
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
});
