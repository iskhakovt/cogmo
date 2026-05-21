import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import type { PtyHandle } from "@daytonaio/sdk";
import { logger } from "../../logger.js";
import { type ExecOptions, type ExecStreamingHandle, ExecTimeoutError } from "../index.js";
import { DisposedError } from "./exec-streaming.js";
import { shellEscape, shellEscapeArgv } from "./shell-quote.js";

const log = logger.child({ component: "sandbox.daytona.exec-pty" });

/**
 * Subset of the Daytona SDK's `Process` actually used by the PTY path —
 * declaring the narrow surface here keeps the test mocks free of the
 * full class's overload soup, and documents the contract this module
 * depends on.
 */
export interface PtyProcessClient {
  createPty(options: {
    id: string;
    cwd?: string;
    envs?: Record<string, string>;
    cols?: number;
    rows?: number;
    onData: (data: Uint8Array) => void | Promise<void>;
  }): Promise<PtyHandle>;
}

/**
 * Subset of the Daytona SDK's `FileSystem` used by the PTY path. The
 * SDK declares overloaded `uploadFile` / `downloadFile` signatures
 * (Buffer vs. path-string); we only need the Buffer-in /
 * Buffer-out variants, so declaring a narrow contract sidesteps the
 * overload conflict in test mocks.
 */
export interface PtyFileSystemClient {
  uploadFile(file: Buffer, remotePath: string): Promise<void>;
  downloadFile(remotePath: string): Promise<Buffer>;
  deleteFile(path: string): Promise<void>;
}

/**
 * PTY-backed exec for callers that need real stdin EOF. The
 * session-command transport over HTTP holds stdin open for the lifetime
 * of `runAsync: true` commands by design (Daytona daemon keeps the FIFO
 * pinned with a long-running `sleep` writer; see daytona#3770/#4107),
 * so any `--input-format stream-json`-style protocol where the child
 * treats stdin EOF as graceful shutdown wedges forever there. The PTY
 * API exposes a real bidirectional WebSocket and an explicit kill RPC,
 * which is what's needed.
 *
 * The prompt arrives via shell-level redirect from a tmpfile (not via
 * `PtyHandle.sendInput`): typing JSON frames directly into a PTY makes
 * stdin a tty for the child, which `claude -p --input-format stream-json`
 * does not accept. Uploading to a tmpfile and exec'ing
 * `claude < /tmp/...` gives the child a real pipe FD that closes when
 * the file is exhausted.
 */
const PTY_COLS = 200;
const PTY_ROWS = 50;
const DISPOSE_GRACE_MS = 5_000;
/**
 * Cap on the stderr tmpfile we drain after the PTY exits. The Daytona
 * `fs.downloadFile` returns the whole file as a `Buffer`, so an
 * unbounded stderr would land in orchestrator memory. claude's
 * stderr is small in practice (warn-level diagnostics only) — this
 * is cheap insurance against a future verbose binary or stuck
 * logging loop.
 */
const MAX_STDERR_BYTES = 1024 * 1024;
const STDERR_TRUNCATED_SUFFIX = "\n[cogmo: stderr truncated]\n";

export async function startExecPty(args: {
  process: PtyProcessClient;
  fs: PtyFileSystemClient;
  sessionIdPrefix: string;
  cmd: readonly string[];
  opts: ExecOptions;
  random?: () => string;
}): Promise<ExecStreamingHandle> {
  const { process: daytonaProcess, fs, sessionIdPrefix, cmd, opts } = args;
  const random = args.random ?? randomUUID;

  if (opts.user !== undefined) {
    throw new Error(
      "DaytonaSandboxSession.execStreaming (PTY): opts.user is not supported in Phase 3a (use `runuser` / `sudo` inside the cmd argv until upstream support lands)",
    );
  }

  const sessionId = `${sessionIdPrefix}-${random()}`;
  const stdinPath = `/tmp/cogmo-pty-stdin-${random()}.bin`;
  const stderrPath = `/tmp/cogmo-pty-stderr-${random()}.log`;

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("error", () => {});
  stderr.on("error", () => {});

  let timedOut: ExecTimeoutError | null = null;
  let disposed = false;
  let totalTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  const clearTimers = (): void => {
    if (totalTimer) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  // Tmpfile cleanup is best-effort — the sandbox tmpfs goes away with
  // the sandbox, so a stuck `deleteFile` doesn't leak across runs. Log
  // and move on.
  let cleanedUp = false;
  const cleanupRemoteFiles = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await Promise.allSettled([
      fs.deleteFile(stdinPath).catch((err: Error) => {
        log.warn({ err: err.message, path: stdinPath }, "deleteFile failed during cleanup");
      }),
      fs.deleteFile(stderrPath).catch((err: Error) => {
        log.warn({ err: err.message, path: stderrPath }, "deleteFile failed during cleanup");
      }),
    ]);
  };

  // PTY merges stdout and stderr; we redirect stderr to a tmpfile in
  // the shell line so onData is clean stdout. Bash prompt + echoed
  // command preamble flows through onData too; the consumer (the
  // claude JSONL parser) drops non-JSON lines via safeParse so the
  // preamble is silently filtered without any sentinel-marker dance.
  let pty: PtyHandle | undefined;
  const handleOnData = (data: Uint8Array): void => {
    resetIdle();
    stdout.write(Buffer.from(data));
  };

  // Idle reset is hoisted so onData can call it before pty/timer
  // state is fully assigned; the closures below see the same `pty`
  // variable.
  function resetIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (opts.idleTimeoutMs !== undefined && !timedOut && !disposed) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (timedOut || disposed) return;
        timedOut = new ExecTimeoutError("idle", opts.idleTimeoutMs ?? 0);
        // Force-kill the PTY; `wait()` resolves and the settle path
        // below maps it to the timeout rejection.
        pty?.kill().catch(() => {});
      }, opts.idleTimeoutMs);
    }
  }

  // Stdin: buffer caller writes until they call `.end()`, then upload
  // and kick off the exec. Callers in cogmo today (runClaudeSession)
  // write one frame then end immediately, so a buffered uploader is
  // sufficient.
  const stdinBuffers: Buffer[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback): void {
      stdinBuffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });

  // Promise resolves when the PTY process exits naturally; rejects on
  // timeout, dispose, or transport error. Order matters: stdin.end()
  // triggers the uploader, which awaits createPty + sendInput; the
  // overall lifetime is bounded by the PTY's wait().
  const exitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
    const startPty = async (): Promise<void> => {
      const stdinPayload = Buffer.concat(stdinBuffers);
      // Check `disposed` after every await so a caller that calls
      // `dispose()` while the IIFE is mid-flight (between stdin.end()
      // and pty.sendInput) doesn't end up running the exec to
      // completion in the background — the PTY would otherwise be
      // born after dispose's `if (pty)` check ran and saw undefined.
      if (disposed) throw new DisposedError();
      await fs.uploadFile(stdinPayload, stdinPath);
      if (disposed) throw new DisposedError();

      pty = await daytonaProcess.createPty({
        id: sessionId,
        // cwd applies to the PTY shell itself, which means the `exec
        // <argv> < … 2> …` line below inherits it — no `cd` prefix
        // needed inside the shell line.
        ...(opts.workingDir !== undefined && { cwd: opts.workingDir }),
        // `PS1=""` suppresses the bash startup prompt so the only
        // pre-claude bytes on onData are the terminal echo of the
        // single exec line we send. `NO_COLOR=1` suppresses ANSI
        // escapes on an isatty stdout. Caller env wins over both.
        envs: { PS1: "", NO_COLOR: "1", ...(opts.env ?? {}) },
        cols: PTY_COLS,
        rows: PTY_ROWS,
        onData: handleOnData,
      });
      if (disposed) {
        await pty.kill().catch(() => undefined);
        throw new DisposedError();
      }
      await pty.waitForConnection();
      if (disposed) {
        await pty.kill().catch(() => undefined);
        throw new DisposedError();
      }

      // Arm timers after the WS is up — they bound the running exec,
      // not the createPty handshake.
      if (opts.timeoutMs !== undefined) {
        totalTimer = setTimeout(() => {
          totalTimer = null;
          if (timedOut || disposed) return;
          timedOut = new ExecTimeoutError("total", opts.timeoutMs ?? 0);
          pty?.kill().catch(() => {});
        }, opts.timeoutMs);
      }
      resetIdle();

      // Send the exec line. `exec` replaces the shell so the PTY's
      // underlying pid becomes claude (or whatever cmd); when it exits
      // the PTY tears down and `pty.wait()` resolves with its exit
      // code, no marker parsing needed. Stdin redirected from the
      // uploaded tmpfile (real pipe FD → kernel-level EOF when
      // exhausted). Stderr to a tmpfile so onData is clean stdout.
      const shellLine = `exec ${shellEscapeArgv(cmd)} < ${shellEscape(stdinPath)} 2> ${shellEscape(stderrPath)}\n`;
      await pty.sendInput(shellLine);
    };

    const settle = async (): Promise<void> => {
      clearTimers();
      stdout.end();

      // Drain stderr tmpfile into the stderr stream — best-effort, so
      // a stuck download doesn't block exit reporting. The download
      // can 404 if the child never wrote to it; that's fine.
      // Truncate at MAX_STDERR_BYTES so a runaway binary doesn't
      // dump unbounded bytes into orchestrator memory.
      try {
        const errBuf = await fs.downloadFile(stderrPath);
        if (errBuf.length > MAX_STDERR_BYTES) {
          stderr.write(errBuf.subarray(0, MAX_STDERR_BYTES));
          stderr.write(STDERR_TRUNCATED_SUFFIX);
        } else if (errBuf.length > 0) {
          stderr.write(errBuf);
        }
      } catch (err) {
        log.debug(
          { err: (err as Error).message, path: stderrPath },
          "stderr tmpfile download failed (often expected — child may not have written)",
        );
      }
      stderr.end();

      await cleanupRemoteFiles();
    };

    (async () => {
      try {
        // stdin.end() is the trigger to start the exec. Wait for it.
        await new Promise<void>((resolveEnd, rejectEnd) => {
          stdin.once("finish", resolveEnd);
          stdin.once("error", rejectEnd);
        });
        await startPty();
      } catch (err) {
        await settle();
        reject(err as Error);
        return;
      }

      const handle = pty;
      if (!handle) {
        await settle();
        reject(new Error("internal: PTY handle was not initialized"));
        return;
      }

      try {
        const result = await handle.wait();
        await settle();
        if (timedOut) {
          reject(timedOut);
          return;
        }
        if (disposed) {
          reject(new DisposedError());
          return;
        }
        // `result.exitCode` is undefined if the PTY closed before the
        // child reported one (transient WS drops, daemon faults).
        // Surface that as a clear error rather than papering over with
        // a sentinel.
        if (result.exitCode === undefined) {
          reject(
            new Error(
              `Daytona PTY ${sessionId} closed without an exit code${result.error ? `: ${result.error}` : ""}`,
            ),
          );
          return;
        }
        resolve({ exitCode: result.exitCode });
      } catch (err) {
        await settle();
        if (timedOut) {
          timedOut.cause = err as Error;
          reject(timedOut);
        } else if (disposed) {
          reject(new DisposedError());
        } else {
          reject(err as Error);
        }
      }
    })();
  });

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    clearTimers();
    if (pty) {
      await pty.kill().catch(() => undefined);
    } else if (!stdin.writableEnded) {
      // Caller called dispose() before `stdin.end()` — the IIFE is
      // still parked on the finish event. Destroy the writable so the
      // rejectEnd branch fires and the IIFE settles into the disposed
      // rejection path.
      stdin.destroy(new DisposedError());
    }
    await Promise.race([
      exitPromise.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_GRACE_MS)),
    ]);
  };

  return {
    stdin,
    stdout,
    stderr,
    wait: () => exitPromise,
    dispose,
  };
}
