import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { Process } from "@daytona/sdk";
import { logger } from "../../logger.js";
import { type ExecOptions, type ExecStreamingHandle, ExecTimeoutError } from "../index.js";
import { shellEscape } from "./shell-quote.js";

const log = logger.child({ component: "sandbox.daytona.exec-streaming" });

/**
 * Thrown by `wait()` after `dispose()` so consumers branching on exit
 * status can distinguish "we killed it" from a real exit code. Matches
 * the contract documented on `ExecStreamingHandle` in
 * `src/sandbox/index.ts` and the Local-Docker backend's behaviour.
 */
export class DisposedError extends Error {
  constructor() {
    super("daytona execStreaming was disposed");
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
  /**
   * Override the per-call session-id randomness. Defaults to
   * `randomUUID`. Conformance tests pin a deterministic value so
   * record/replay's `(method, path)` FIFO matching stays stable.
   */
  random?: () => string;
}): Promise<ExecStreamingHandle> {
  const { process: daytonaProcess, sessionIdPrefix, cmd, opts, onClose } = args;
  const random = args.random ?? randomUUID;

  // Phase 3a does not implement `opts.user` for Daytona. The
  // Local-Docker backend honours it via dockerode's `User` field;
  // silently dropping it here would diverge backends invisibly. Match
  // the rest of the Phase-3a "not supported" pattern (`worktree`,
  // `askpass`, `homeVolume`) and reject loudly.
  if (opts.user !== undefined) {
    throw new Error(
      "DaytonaSandboxSession.execStreaming: opts.user is not supported in Phase 3a (use `runuser` / `sudo` inside the cmd argv until upstream support lands)",
    );
  }

  // Session-command stdin (`sendSessionCommandInput` HTTP POST) has no
  // remote EOF channel — the daemon pins the FIFO with a long-running
  // sleep for `runAsync: true` commands, so any caller that relies on
  // stdin EOF wedges. `attachStdin: true` is routed to the PTY
  // backend (`startExecPty`) before this point; reject if it somehow
  // reaches here.
  if (opts.attachStdin === true) {
    throw new Error(
      "DaytonaSandboxSession.execStreaming: attachStdin must be routed to the PTY backend (startExecPty); session-command stdin has no remote EOF channel",
    );
  }

  // Per-call session — `deleteSession` is the only kill primitive
  // Daytona offers, and we want it to affect only this command.
  // `randomUUID()` (128 bits, crypto-grade) makes collisions
  // effectively impossible — important because a collision wouldn't
  // fail loudly, it would silently make `dispose()` on one call tear
  // down a sibling call's session.
  const sessionId = `${sessionIdPrefix}-${random()}`;
  await daytonaProcess.createSession(sessionId);

  // Idempotent session teardown. Called from every termination path —
  // natural WS close (success), WS error (real upstream failure), and
  // explicit `dispose()`. Without it, sessions leak per
  // `execStreaming` call.
  //
  // `cleanedUp` flips ONLY after `deleteSession` resolves
  // successfully. A failed delete leaves the flag false. The
  // `while (inFlight)` waits for any other caller's attempt; if that
  // attempt failed, control falls through and the current caller
  // fires its own. Each caller attempts at most once, but callers
  // chain so the last one in always retries on persistent failure —
  // closes the leak window where N concurrent callers all queue
  // behind one failing attempt and return without trying.
  let cleanedUp = false;
  let inFlight: Promise<void> | null = null;
  const cleanupSession = async (): Promise<void> => {
    if (cleanedUp) return;
    while (inFlight) {
      // `.catch` swallows so a failed in-flight doesn't reject our
      // own promise — we re-check `cleanedUp` and decide whether to
      // retry below.
      await inFlight.catch(() => undefined);
      if (cleanedUp) return;
      // Race protection: if another caller raced into this branch
      // between the await and now and started a new in-flight, loop
      // and wait on theirs too.
    }
    inFlight = (async () => {
      try {
        await daytonaProcess.deleteSession(sessionId);
        cleanedUp = true;
      } catch (err) {
        log.warn({ err: (err as Error).message, sessionId }, "deleteSession during cleanup failed");
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  };

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // Always-attached no-op `'error'` absorbers. Stream errors fire when
  // the WS error path calls `stream.destroy(err)`; without a listener,
  // Node escalates to `uncaughtException` and crashes the worker.
  // Consumers attaching their own `'error'` listeners get them
  // additively — Node delivers events to all listeners. This is the
  // contract guarantee that lets `ExecStreamingHandle.stdout` /
  // `.stderr` be safe even when nobody else is listening.
  stdout.on("error", () => {});
  stderr.on("error", () => {});

  // Daytona's session-exec command is a single shell command string, not
  // argv. Quote each arg for `bash -lc` safely. `cmd[0]` may already be
  // the binary name; treat the whole array as a quoted argv to be exec'd
  // by bash.
  const command = buildShellCommand(cmd, opts);

  // If the kickoff itself fails (network blip, daemon error), the
  // session we just created would orphan unless we explicitly clean it
  // up before re-throwing. Wrap in try/catch.
  let commandId: string;
  try {
    const startResp = await daytonaProcess.executeSessionCommand(sessionId, {
      command,
      runAsync: true,
    });
    if (!startResp.cmdId) {
      throw new Error("daytona executeSessionCommand returned no cmdId");
    }
    commandId = startResp.cmdId;
  } catch (err) {
    await cleanupSession();
    throw err;
  }

  // Timeout state — see "Wall-clock and idle timeouts" in
  // design/sandbox.md. Both timers fire independently; whichever lands
  // first wins. The natural-exit and explicit-dispose paths both clear
  // them so they never fire after the exec has already settled.
  let timedOut: ExecTimeoutError | null = null;
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

  // Open the streaming WebSocket. The promise resolves when the WS closes
  // — whether because the command exited cleanly or because we
  // `deleteSession`'d the session out from under it. Errors (transient
  // network drops, server faults) reject; we forward to stdout consumers.
  //
  // The chunk callbacks also reset the idle watchdog — any byte from
  // the remote command counts as activity.
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (opts.idleTimeoutMs !== undefined && !timedOut) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (timedOut) return;
        timedOut = new ExecTimeoutError("idle", opts.idleTimeoutMs ?? 0);
        // Force the WS to close by tearing down the session. The
        // wsPromise chain below will then settle into the timeout
        // branch and reject `exitPromise`.
        cleanupSession().catch(() => {});
      }, opts.idleTimeoutMs);
    }
  };

  const wsPromise = daytonaProcess.getSessionCommandLogs(
    sessionId,
    commandId,
    (chunk) => {
      resetIdle();
      stdout.write(chunk);
    },
    (chunk) => {
      resetIdle();
      stderr.write(chunk);
    },
  );

  // Arm the total wall-clock timer + initial idle timer immediately
  // after the WS handshake is requested. Idle timer's setup is
  // factored into `resetIdle()` so chunk arrivals re-arm it without
  // duplicating logic.
  if (opts.timeoutMs !== undefined) {
    totalTimer = setTimeout(() => {
      totalTimer = null;
      if (timedOut) return;
      timedOut = new ExecTimeoutError("total", opts.timeoutMs ?? 0);
      cleanupSession().catch(() => {});
    }, opts.timeoutMs);
  }
  resetIdle();

  // The exit channel: WS close → fetch `getSessionCommand` for the exit
  // code. If WS errored, surface the error (consumers may have already
  // received partial output via stdout/stderr). Every settle path runs
  // `cleanupSession` so per-call Daytona sessions don't leak.
  //
  // Per the `ExecStreamingHandle` contract, `wait()` rejects with
  // `DisposedError` after `dispose()` instead of resolving with a
  // sentinel exit code — that forces consumers to handle the dispose
  // path explicitly rather than confusing it with a real exit signal.
  // Timeouts get their own sentinel `ExecTimeoutError` for the same
  // reason; consumers branching on outcome can separate "we capped" from
  // "we cancelled" from "real exit code."
  let disposed = false;
  const exitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
    wsPromise
      .then(async () => {
        clearTimers();
        stdout.end();
        stderr.end();
        if (onClose) onClose();
        // `getSessionCommand` 404s once the session is deleted, so
        // cleanup must run after the fetch on the success path.
        // `try/finally` ensures cleanup on every settle path
        // (timedOut, disposed, success, fetch-error). Idempotent via
        // the `cleanedUp` guard in `cleanupSession`.
        try {
          if (timedOut) {
            reject(timedOut);
            return;
          }
          if (disposed) {
            reject(new DisposedError());
            return;
          }
          const cmd = await daytonaProcess.getSessionCommand(sessionId, commandId);
          if (cmd.exitCode === undefined || cmd.exitCode === null) {
            reject(
              new Error(
                `Daytona session ${sessionId} command ${commandId} exited but reported no exit code`,
              ),
            );
            return;
          }
          resolve({ exitCode: cmd.exitCode });
        } catch (err) {
          // Map back to the documented sentinel when a settle flag is
          // set — `dispose()` racing the in-flight fetch surfaces as
          // `DaytonaNotFoundError` from the SDK; consumers branching
          // on outcome must see `DisposedError`. Mirrors `.catch`'s
          // shape. `timedOut` is unreachable here (clearTimers runs
          // above the try) but checked for parity.
          if (timedOut) {
            timedOut.cause = err as Error;
            reject(timedOut);
          } else if (disposed) {
            reject(new DisposedError());
          } else {
            reject(err as Error);
          }
        } finally {
          await cleanupSession();
        }
      })
      .catch(async (err: Error) => {
        clearTimers();
        stdout.end();
        stderr.end();
        if (onClose) onClose();
        await cleanupSession();
        if (timedOut) {
          // Preserve the WS error as `cause` so the original transport
          // failure is recoverable in logs when the timer raced a
          // real upstream error.
          timedOut.cause = err;
          reject(timedOut);
          return;
        }
        if (disposed) {
          // Expected — dispose tore down the WS. Reject with the
          // sentinel error type per the interface contract.
          reject(new DisposedError());
          return;
        }
        // Real upstream error — destroy downstreams so any consumers
        // currently reading see the failure (and our own no-op
        // `'error'` absorbers swallow the per-stream notification).
        stdout.destroy(err);
        stderr.destroy(err);
        reject(err);
      });
  });
  // Suppress unhandled-rejection if caller never awaits wait().
  exitPromise.catch(() => {});

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    clearTimers();
    // `cleanupSession` is the canonical teardown — also called by the
    // natural-exit path above, so this is idempotent. Tearing down the
    // session also closes the WS, which triggers the rejection branch
    // above; that branch sees `disposed=true` and resolves the exit
    // promise with sentinel 137.
    await cleanupSession();
    // Cap the wait so dispose can't hang forever if Daytona's WS stays
    // half-open after deleteSession (unlikely but cheap insurance).
    await Promise.race([
      exitPromise.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_GRACE_MS)),
    ]);
  };

  const handle: ExecStreamingHandle = {
    // PassThrough is a Duplex which is itself a Readable — direct
    // assignment without a cast is structurally type-safe.
    stdout,
    stderr,
    wait: () => exitPromise,
    dispose,
  };
  return handle;
}

function buildShellCommand(cmd: readonly string[], opts: ExecOptions): string {
  // Run the argv as a normal child of bash: cwd via `cd`, env via the `env`
  // CLI scoped to this command. The target binary MUST run as a child
  // (not via bash's `exec` builtin) — Daytona's session-command lifecycle
  // detects completion via the session shell's exit, and `exec` replaces
  // the shell so that exit never fires. Daytona [#2513] is the upstream
  // gap; running as a child gives the shell a clean exit to report.
  const envPrefix =
    opts.env && Object.keys(opts.env).length > 0
      ? `env ${Object.entries(opts.env)
          .map(([k, v]) => `${shellEscape(k)}=${shellEscape(v)}`)
          .join(" ")} `
      : "";
  const cdPrefix = opts.workingDir ? `cd ${shellEscape(opts.workingDir)} && ` : "";
  const argv = cmd.map(shellEscape).join(" ");
  return `${cdPrefix}${envPrefix}${argv}`;
}
