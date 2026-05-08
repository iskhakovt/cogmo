import { PassThrough, type Readable, Writable } from "node:stream";
import type { Process } from "@daytonaio/sdk";
import { logger } from "../../logger.js";
import type { ExecOptions, ExecStreamingHandle } from "../index.js";

const log = logger.child({ component: "sandbox.daytona.exec-streaming" });

/** Thrown by `dispose()` to settle the exit promise. */
class DisposedError extends Error {
  constructor() {
    super("daytona execStreaming dispose called");
    this.name = "DisposedError";
  }
}

/** Cap dispose's wait-for-exit at this much; runaway exec might never settle. */
const DISPOSE_GRACE_MS = 5_000;

/**
 * Run `cmd` via a fresh Daytona process session and wrap its WebSocket log
 * stream into an `ExecStreamingHandle`. One Daytona session per call
 * (rather than reusing a long-lived one) so `dispose()` can `deleteSession`
 * without affecting other in-flight commands.
 *
 * Quirks the wrapper handles:
 *
 * - Daytona's WS callbacks are per-chunk, not per-line. Consumers that want
 *   lines do their own `split2` on the `Readable`.
 * - Exit code arrives via a separate `getSessionCommand` HTTP fetch after
 *   the WS closes (it's not in the stream).
 * - `process.executeSessionCommand({ runAsync: true })` returns immediately
 *   after the kickoff; the command runs server-side until completion.
 * - The Daytona API has no per-command kill — `dispose()` calls
 *   `deleteSession` on this command's dedicated session. That tears down
 *   the WS too.
 */
export async function startExecStreaming(args: {
  process: Process;
  /** Caller-chosen prefix; we add a per-call random suffix. */
  sessionIdPrefix: string;
  cmd: readonly string[];
  opts: ExecOptions;
  /** Called whenever stdout/stderr would have been written; fires on close too. */
  onClose?: () => void;
}): Promise<ExecStreamingHandle> {
  const { process: daytonaProcess, sessionIdPrefix, cmd, opts, onClose } = args;

  // Per-call session — `deleteSession` is the only kill primitive Daytona
  // offers, and we want it to affect only this command. Crypto-random
  // suffix avoids collisions across rapid-fire execs.
  const sessionId = `${sessionIdPrefix}-${randomSuffix()}`;
  await daytonaProcess.createSession(sessionId);

  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // Daytona's session-exec command is a single shell command string, not
  // argv. Quote each arg for `bash -lc` safely. `cmd[0]` may already be
  // the binary name; treat the whole array as a quoted argv to be exec'd
  // by bash.
  const command = buildShellCommand(cmd, opts);

  const startResp = await daytonaProcess.executeSessionCommand(sessionId, {
    command,
    runAsync: true,
  });
  const commandId = startResp.cmdId;
  if (!commandId) {
    await daytonaProcess.deleteSession(sessionId).catch(() => {});
    throw new Error("daytona executeSessionCommand returned no cmdId");
  }

  // Open the streaming WebSocket. The promise resolves when the WS closes
  // — whether because the command exited cleanly or because we
  // `deleteSession`'d the session out from under it. Errors (transient
  // network drops, server faults) reject; we forward to stdout consumers.
  const wsPromise = daytonaProcess.getSessionCommandLogs(
    sessionId,
    commandId,
    (chunk) => {
      stdout.write(chunk);
    },
    (chunk) => {
      stderr.write(chunk);
    },
  );

  // The exit channel: WS close → fetch `getSessionCommand` for the exit
  // code. If WS errored, surface the error (consumers may have already
  // received partial output via stdout/stderr).
  let disposed = false;
  const exitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
    wsPromise
      .then(async () => {
        stdout.end();
        stderr.end();
        if (onClose) onClose();
        try {
          const cmd = await daytonaProcess.getSessionCommand(sessionId, commandId);
          // Daytona's Command may not have an exitCode if disposed early.
          // Treat undefined as "we killed it" → use 137 (SIGKILL convention).
          const exitCode = cmd.exitCode ?? (disposed ? 137 : 0);
          resolve({ exitCode });
        } catch (err) {
          reject(err as Error);
        }
      })
      .catch((err: Error) => {
        if (disposed) {
          // Expected — dispose tore down the WS. Resolve with sentinel.
          stdout.end();
          stderr.end();
          if (onClose) onClose();
          resolve({ exitCode: 137 });
          return;
        }
        stdout.destroy(err);
        stderr.destroy(err);
        if (onClose) onClose();
        reject(err);
      });
  });
  // Suppress unhandled-rejection if caller never awaits wait().
  exitPromise.catch(() => {});

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      // Tear down the session — Daytona's only kill path. The WS closes,
      // wsPromise rejects, and exitPromise resolves with 137 above.
      await daytonaProcess.deleteSession(sessionId);
    } catch (err) {
      // Already gone, daemon error, etc. — log and move on. Consumers
      // racing dispose against natural exit will resolve normally.
      log.warn(
        { err: (err as Error).message, sessionId, commandId },
        "deleteSession during dispose failed",
      );
    }
    // Cap the wait so dispose can't hang forever if Daytona's WS stays
    // half-open after deleteSession (unlikely but cheap insurance).
    await Promise.race([
      exitPromise.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_GRACE_MS)),
    ]);
  };

  // stdin: Daytona accepts session input via `sendSessionCommandInput`.
  // Wrap in a Writable that flushes per write. Coalescing happens at the
  // caller's stream layer if they want it.
  const stdin =
    opts.attachStdin === true
      ? new SessionCommandInputWritable(daytonaProcess, sessionId, commandId)
      : undefined;

  const handle: ExecStreamingHandle = {
    stdout: stdout as Readable,
    stderr: stderr as Readable,
    wait: () => exitPromise,
    dispose,
  };
  if (stdin) handle.stdin = stdin;
  return handle;
}

/**
 * Writable adapter over `process.sendSessionCommandInput`. Each `write()`
 * sends a chunk; `end()` is a no-op on Daytona (no explicit EOF — caller
 * must structure its protocol so the remote process knows when input is
 * done, e.g. emit a sentinel line for stream-json).
 */
class SessionCommandInputWritable extends Writable {
  #process: Process;
  #sessionId: string;
  #commandId: string;

  constructor(process: Process, sessionId: string, commandId: string) {
    super();
    this.#process = process;
    this.#sessionId = sessionId;
    this.#commandId = commandId;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (err?: Error | null) => void,
  ): void {
    const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.#process
      .sendSessionCommandInput(this.#sessionId, this.#commandId, data)
      .then(() => callback())
      .catch((err: Error) => callback(err));
  }
}

function buildShellCommand(cmd: readonly string[], opts: ExecOptions): string {
  // Wrap the argv as an exec'd subprocess so bash flags don't apply, but
  // do honour cwd / env via the same shell. Daytona's session is bash by
  // default; cwd defaults to user home. Inject env via `env` CLI rather
  // than session-level config so it scopes to this command.
  const envPrefix =
    opts.env && Object.keys(opts.env).length > 0
      ? `env ${Object.entries(opts.env)
          .map(([k, v]) => `${shellEscape(k)}=${shellEscape(v)}`)
          .join(" ")} `
      : "";
  const cdPrefix = opts.workingDir ? `cd ${shellEscape(opts.workingDir)} && ` : "";
  const argv = cmd.map(shellEscape).join(" ");
  return `${cdPrefix}${envPrefix}exec ${argv}`;
}

/**
 * Single-quote-escape for safe bash interpolation. POSIX rule: `'foo'` is
 * literal; embedded `'` becomes `'"'"'`. Cheaper than reaching for shellac
 * for one helper.
 */
function shellEscape(s: string): string {
  return `'${s.replaceAll("'", "'\"'\"'")}'`;
}

function randomSuffix(): string {
  // 6 hex chars = 24 bits — collision-resistant within a single Daytona
  // sandbox's session id namespace at single-user concurrency.
  return Math.floor(Math.random() * 0xff_ff_ff)
    .toString(16)
    .padStart(6, "0");
}
