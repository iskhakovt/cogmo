import { randomUUID } from "node:crypto";
import type { Process } from "@daytona/sdk";
import { err, ok, type Result } from "neverthrow";
import type { ExecOptions, ExecStreamingHandle } from "../exec.js";
import { type ExecBackend, type ExecSink, type ExecStarted, runExec } from "../exec-run.js";
import { shellEscape } from "./shell-quote.js";

/**
 * Run `cmd` as a Daytona session command and stream its session-logs
 * WebSocket through the shared exec lifecycle (`exec-run.ts`).
 *
 * Quirks the backend handles:
 *
 * - One Daytona session per call. The API has no per-command kill:
 *   `deleteSession` is the only teardown, so each command gets a session of
 *   its own, and deleting it also closes the WebSocket.
 * - The WS callbacks are per-chunk, not per-line.
 * - The exit code is not in the stream: it comes from `getSessionCommand`
 *   once the WS closes, and that 404s once the session is deleted, so the
 *   lifecycle fetches it before tearing down.
 * - WS close is the only completion signal, and it isn't reliable (Daytona
 *   #2510, #2513). The run's deadlines settle without it, and never wait on
 *   `deleteSession` to close it.
 */
export async function startExecStreaming(args: {
  process: Process;
  /** Caller-chosen prefix; we add a per-call random suffix. */
  sessionIdPrefix: string;
  cmd: readonly string[];
  opts: ExecOptions;
  /**
   * Override the per-call session-id randomness. Defaults to
   * `randomUUID`. Conformance tests pin a deterministic value so
   * record/replay's `(method, path)` FIFO matching stays stable.
   */
  random?: () => string;
}): Promise<ExecStreamingHandle> {
  const { opts } = args;
  const random = args.random ?? randomUUID;

  // Local-Docker honours `opts.user` via dockerode's `User` field; dropping
  // it here would diverge the backends invisibly.
  if (opts.user !== undefined) {
    throw new Error(
      "DaytonaSandboxSession.execStreaming: opts.user is not supported in Phase 3a (use `runuser` / `sudo` inside the cmd argv until upstream support lands)",
    );
  }

  // Session-command stdin (`sendSessionCommandInput`) has no remote EOF: the
  // daemon pins the FIFO open for `runAsync: true` commands. `attachStdin`
  // execs take the PTY backend (`startExecPty`).
  if (opts.attachStdin === true) {
    throw new Error(
      "DaytonaSandboxSession.execStreaming: attachStdin must be routed to the PTY backend (startExecPty); session-command stdin has no remote EOF channel",
    );
  }

  // `randomUUID()` makes a collision effectively impossible — one would not
  // fail loudly, it would let one call's teardown delete a sibling's session.
  const sessionId = `${args.sessionIdPrefix}-${random()}`;
  return runExec(
    new DaytonaSessionBackend(args.process, sessionId, buildShellCommand(args.cmd, opts)),
    opts,
  );
}

class DaytonaSessionBackend implements ExecBackend {
  readonly buffersStdin = false;
  readonly logFields: Record<string, unknown>;
  #process: Process;
  #sessionId: string;
  #command: string;
  #commandId: string | undefined;
  #created = false;
  /** The session's deletion, once it succeeded or while it runs. */
  #deletion: Promise<void> | undefined;

  constructor(process: Process, sessionId: string, command: string) {
    this.#process = process;
    this.#sessionId = sessionId;
    this.#command = command;
    this.logFields = { sessionId };
  }

  async start(
    sink: ExecSink,
    _stdin: Buffer | undefined,
    signal: AbortSignal,
  ): Promise<ExecStarted> {
    await this.#process.createSession(this.#sessionId);
    this.#created = true;
    signal.throwIfAborted();
    const started = await this.#process.executeSessionCommand(this.#sessionId, {
      command: this.#command,
      runAsync: true,
    });
    signal.throwIfAborted();
    if (!started.cmdId) throw new Error("daytona executeSessionCommand returned no cmdId");
    const commandId = started.cmdId;
    this.#commandId = commandId;
    this.#process
      .getSessionCommandLogs(
        this.#sessionId,
        commandId,
        (chunk) => sink.output("stdout", Buffer.from(chunk, "utf8")),
        (chunk) => sink.output("stderr", Buffer.from(chunk, "utf8")),
      )
      .then(
        () => sink.ended(),
        (e: unknown) => sink.failed(e),
      );
    return {};
  }

  async fetchExit(): Promise<Result<number, string>> {
    const commandId = this.#commandId;
    if (commandId === undefined) throw new Error("daytona session output ended before it started");
    const command = await this.#process.getSessionCommand(this.#sessionId, commandId);
    return command.exitCode === undefined || command.exitCode === null
      ? err(
          `Daytona session ${this.#sessionId} command ${commandId} exited but reported no exit code`,
        )
      : ok(command.exitCode);
  }

  /** Delete the session once; a failed attempt leaves the next one free to retry. */
  teardown(): Promise<void> {
    if (!this.#created) return Promise.resolve();
    this.#deletion ??= this.#process.deleteSession(this.#sessionId).catch((e: unknown) => {
      this.#deletion = undefined;
      throw e;
    });
    return this.#deletion;
  }
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
