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
 *
 * Consumer contract:
 *
 * - Stdin is buffered in process memory until `.end()`, then uploaded
 *   in one shot. Single-message protocols only.
 * - Stdout carries the PTY's echo of the typed `exec …` line ahead of
 *   the child's output. Today's only consumer (`parseClaudeStream`)
 *   drops non-JSONL lines via `safeParse`; non-JSONL consumers must
 *   tolerate or filter the preamble themselves.
 * - Stderr is drained from a tmpfile after exit, capped at
 *   `MAX_STDERR_BYTES` with a truncation marker.
 * - `opts.timeoutMs` bounds the whole lifetime (pre-end wait, upload,
 *   createPty handshake, sendInput, running exec). `opts.idleTimeoutMs`
 *   only arms once `sendInput` has dispatched.
 */
const PTY_COLS = 200;
const PTY_ROWS = 50;
const DISPOSE_GRACE_MS = 5_000;
/** Cap on the stderr tmpfile drained after exit — `downloadFile` is unbounded. */
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

  // Tmpfile cleanup is best-effort; sandbox tmpfs vanishes on teardown.
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

  let pty: PtyHandle | undefined;
  const handleOnData = (data: Uint8Array): void => {
    resetIdle();
    stdout.write(Buffer.from(data));
  };

  /** Idempotent kill — silent if `pty` is undefined or the RPC races natural exit. */
  const killPty = (): Promise<void> => pty?.kill().catch(() => undefined) ?? Promise.resolve();

  // Hoisted so `handleOnData` above can reference it.
  function resetIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (opts.idleTimeoutMs !== undefined && !timedOut && !disposed) {
      const idleMs = opts.idleTimeoutMs;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (timedOut || disposed) return;
        timedOut = new ExecTimeoutError("idle", idleMs);
        void killPty();
      }, idleMs);
    }
  }

  const stdinBuffers: Buffer[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback): void {
      stdinBuffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });

  // Total timer covers the whole lifetime — including upload,
  // createPty, and a caller that never `.end()`s stdin.
  if (opts.timeoutMs !== undefined) {
    const totalMs = opts.timeoutMs;
    totalTimer = setTimeout(() => {
      totalTimer = null;
      if (timedOut || disposed) return;
      timedOut = new ExecTimeoutError("total", totalMs);
      void killPty();
      if (!stdin.writableEnded) stdin.destroy(timedOut);
    }, totalMs);
  }

  const exitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
    // Throw the right sentinel so the catch below rejects with
    // `DisposedError` / `ExecTimeoutError` instead of whatever
    // downstream error a half-built exec would surface.
    const checkAborted = (): void => {
      if (disposed) throw new DisposedError();
      if (timedOut) throw timedOut;
    };

    const startPty = async (): Promise<void> => {
      const stdinPayload = Buffer.concat(stdinBuffers);
      // Re-checked after every await so a `dispose()` or total-timer
      // fire mid-flight doesn't end up running the exec anyway.
      checkAborted();
      await fs.uploadFile(stdinPayload, stdinPath);
      checkAborted();

      pty = await daytonaProcess.createPty({
        id: sessionId,
        // The PTY shell starts in `cwd`, so the `exec …` line below
        // inherits it.
        ...(opts.workingDir !== undefined && { cwd: opts.workingDir }),
        // `PS1=""` mutes the shell prompt; `NO_COLOR=1` mutes ANSI on
        // isatty stdout. Caller env overrides both. (Custom images
        // that source `/etc/bash.bashrc` may still leak rc-file
        // output here — cogmo-devbase doesn't.)
        envs: { PS1: "", NO_COLOR: "1", ...(opts.env ?? {}) },
        // 200x50 is generous; sized for claude's wide tool output.
        // Lift to `ExecOptions` when a binary needs explicit COLUMNS.
        cols: PTY_COLS,
        rows: PTY_ROWS,
        onData: handleOnData,
      });
      if (disposed || timedOut) {
        await killPty();
        checkAborted();
      }
      await pty.waitForConnection();
      if (disposed || timedOut) {
        await killPty();
        checkAborted();
      }

      // Idle watchdog arms now that bytes can flow; total timer
      // already armed at function entry.
      resetIdle();

      // `cat file | cmd` (not `cmd < file`): claude 2.1.138 silently
      // exits 0 with no output when stream-json input arrives via a
      // regular file FD. Outer `exec bash --norc --noprofile -c` swaps
      // the default interactive bash for a non-interactive one — no
      // readline echo, no `PROMPT_COMMAND` OSCs after the swap.
      const innerScript = `cat ${shellEscape(stdinPath)} | exec ${shellEscapeArgv(cmd)} 2> ${shellEscape(stderrPath)}`;
      const shellLine = `exec bash --norc --noprofile -c ${shellEscape(innerScript)}\n`;
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
        // `warn` not `debug`: when claude exits silently with no
        // stream-json output, the stderr tmpfile is the only diagnostic
        // for *why* — surfacing the download failure at `info` level
        // means operators see the breadcrumb without dropping LOG_LEVEL.
        // A child that simply never wrote to stderr is the common case;
        // the warn is acceptable noise to keep the rare-but-critical
        // case visible.
        log.warn(
          { err: (err as Error).message, path: stderrPath },
          "stderr tmpfile download failed (often expected — child may not have written)",
        );
      }
      stderr.end();

      // `disconnect()` is idempotent and frees the local WS even when
      // natural exit already closed it server-side.
      if (pty) await pty.disconnect().catch(() => undefined);

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
      await killPty();
    } else if (!stdin.writableEnded) {
      // Unblock the IIFE parked on `stdin.once("finish")`.
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
