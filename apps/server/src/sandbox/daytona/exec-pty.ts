import { randomUUID } from "node:crypto";
import { DaytonaNotFoundError, type PtyHandle, type PtyResult } from "@daytona/sdk";
import { err, ok, type Result } from "neverthrow";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import type { ExecOptions, ExecStreamingHandle } from "../exec.js";
import { type ExecBackend, type ExecSink, type ExecStarted, runExec } from "../exec-run.js";
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

const PTY_COLS = 200;
const PTY_ROWS = 50;
/** Cap on the stderr tmpfile drained after exit — `downloadFile` is unbounded. */
const MAX_STDERR_BYTES = 1024 * 1024;
const STDERR_TRUNCATED_SUFFIX = "\n[cogmo: stderr truncated]\n";

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
 * - `opts.timeoutMs` bounds everything up to the exit code: the wait for
 *   `.end()`, the upload, `createPty`, the connect, `sendInput`, the run
 *   and the stderr download. `opts.idleTimeoutMs` arms once the command
 *   line is sent.
 */
export async function startExecPty(args: {
  process: PtyProcessClient;
  fs: PtyFileSystemClient;
  sessionIdPrefix: string;
  cmd: readonly string[];
  opts: ExecOptions;
  random?: () => string;
}): Promise<ExecStreamingHandle> {
  if (args.opts.user !== undefined) {
    throw new Error(
      "DaytonaSandboxSession.execStreaming (PTY): opts.user is not supported in Phase 3a (use `runuser` / `sudo` inside the cmd argv until upstream support lands)",
    );
  }
  const random = args.random ?? randomUUID;
  return runExec(
    new DaytonaPtyBackend({
      process: args.process,
      fs: args.fs,
      cmd: args.cmd,
      opts: args.opts,
      sessionId: `${args.sessionIdPrefix}-${random()}`,
      stdinPath: `/tmp/cogmo-pty-stdin-${random()}.bin`,
      stderrPath: `/tmp/cogmo-pty-stderr-${random()}.log`,
    }),
    args.opts,
  );
}

class DaytonaPtyBackend implements ExecBackend {
  readonly buffersStdin = true;
  readonly logFields: Record<string, unknown>;
  #process: PtyProcessClient;
  #fs: PtyFileSystemClient;
  #cmd: readonly string[];
  #opts: ExecOptions;
  #sessionId: string;
  #stdinPath: string;
  #stderrPath: string;
  #sink: ExecSink | undefined;
  #pty: PtyHandle | undefined;
  /** What `PtyHandle.wait()` reported, once it has. */
  #exit: PtyResult | undefined;

  constructor(args: {
    process: PtyProcessClient;
    fs: PtyFileSystemClient;
    cmd: readonly string[];
    opts: ExecOptions;
    sessionId: string;
    stdinPath: string;
    stderrPath: string;
  }) {
    this.#process = args.process;
    this.#fs = args.fs;
    this.#cmd = args.cmd;
    this.#opts = args.opts;
    this.#sessionId = args.sessionId;
    this.#stdinPath = args.stdinPath;
    this.#stderrPath = args.stderrPath;
    this.logFields = { sessionId: args.sessionId };
  }

  async start(
    sink: ExecSink,
    stdin: Buffer | undefined,
    signal: AbortSignal,
  ): Promise<ExecStarted> {
    this.#sink = sink;
    await this.#fs.uploadFile(stdin ?? Buffer.alloc(0), this.#stdinPath);
    signal.throwIfAborted();
    const pty = await this.#process.createPty({
      id: this.#sessionId,
      // The PTY shell starts in `cwd`, so the `exec …` line below inherits it.
      ...(this.#opts.workingDir !== undefined && { cwd: this.#opts.workingDir }),
      // `PS1=""` mutes the shell prompt; `NO_COLOR=1` mutes ANSI on isatty
      // stdout. Caller env overrides both. (Custom images that source
      // `/etc/bash.bashrc` may still leak rc-file output here —
      // cogmo-devbase doesn't.)
      envs: { PS1: "", NO_COLOR: "1", ...(this.#opts.env ?? {}) },
      // 200x50 is generous; sized for claude's wide tool output. Lift to
      // `ExecOptions` when a binary needs explicit COLUMNS.
      cols: PTY_COLS,
      rows: PTY_ROWS,
      onData: (data) => sink.output("stdout", Buffer.from(data)),
    });
    this.#pty = pty;
    // `PtyHandle.wait()` (@daytona/sdk 0.214) settles on the `exited`
    // control frame or on the WS closing. A normal close (1000) with no
    // parseable reason reads as exit 0; an abnormal one (1006) resolves it
    // with no exit code; and a `wait()` first called after such a close
    // never settles, so register it before anything can close the socket.
    // `kill()` sets no exit code either.
    pty.wait().then(
      (exit) => {
        this.#exit = exit;
        sink.ended();
      },
      (e: unknown) => sink.failed(e),
    );
    signal.throwIfAborted();
    await pty.waitForConnection();
    signal.throwIfAborted();
    // `cat file | cmd` (not `cmd < file`): claude 2.1.138 silently exits 0
    // with no output when stream-json input arrives via a regular file FD.
    // The outer `exec bash --norc --noprofile -c` swaps the default
    // interactive bash for a non-interactive one — no readline echo, no
    // `PROMPT_COMMAND` OSCs after the swap.
    const innerScript = `cat ${shellEscape(this.#stdinPath)} | exec ${shellEscapeArgv(this.#cmd)} 2> ${shellEscape(this.#stderrPath)}`;
    await pty.sendInput(`exec bash --norc --noprofile -c ${shellEscape(innerScript)}\n`);
    return {};
  }

  /** Drain the stderr tmpfile into the stderr stream, then report the exit the PTY gave. */
  async fetchExit(): Promise<Result<number, string>> {
    const exitCode = this.#exit?.exitCode;
    await this.#drainStderr(exitCode);
    if (exitCode === undefined) {
      const reason = this.#exit?.error;
      return err(
        `Daytona PTY ${this.#sessionId} closed without an exit code${reason ? `: ${reason}` : ""}`,
      );
    }
    return ok(exitCode);
  }

  /**
   * Best effort: the child may never have written to it, so a failed
   * download is logged, loudly only when a non-zero exit makes the tmpfile
   * the one diagnostic of why.
   */
  async #drainStderr(exitCode: number | undefined): Promise<void> {
    try {
      const errBuf = await this.#fs.downloadFile(this.#stderrPath);
      if (errBuf.length > MAX_STDERR_BYTES) {
        this.#sink?.output("stderr", errBuf.subarray(0, MAX_STDERR_BYTES));
        this.#sink?.output("stderr", Buffer.from(STDERR_TRUNCATED_SUFFIX));
      } else if (errBuf.length > 0) {
        this.#sink?.output("stderr", errBuf);
      }
    } catch (e) {
      const level = exitCode !== undefined && exitCode !== 0 ? "warn" : "debug";
      log[level](
        { err: describeError(e), path: this.#stderrPath, exitCode },
        "stderr tmpfile download failed",
      );
    }
  }

  /**
   * Kill the PTY unless it reported an exit code, drop the local WebSocket,
   * and delete both tmpfiles. A close with no exit code (1006) says nothing
   * about the remote command, which may still run, so that gets the kill
   * too; a kill that 404s finds the PTY gone already. The deletes are best
   * effort: the sandbox's `/tmp` goes with it.
   */
  async teardown(): Promise<void> {
    const pty = this.#pty;
    const files = Promise.all(
      [this.#stdinPath, this.#stderrPath].map((path) =>
        this.#fs.deleteFile(path).catch((e: unknown) => {
          log.debug({ err: describeError(e), path }, "tmpfile delete failed");
        }),
      ),
    );
    if (pty) {
      try {
        if (this.#exit?.exitCode === undefined) await killUnlessGone(pty);
      } finally {
        await pty.disconnect().catch(() => undefined);
      }
    }
    await files;
  }
}

async function killUnlessGone(pty: PtyHandle): Promise<void> {
  try {
    await pty.kill();
  } catch (e) {
    if (!(e instanceof DaytonaNotFoundError)) throw e;
  }
}
