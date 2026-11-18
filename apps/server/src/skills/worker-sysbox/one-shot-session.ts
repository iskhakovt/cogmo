import { randomUUID } from "node:crypto";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import type { z } from "zod";
import { logger } from "../../logger.js";
import type { ExecFailure } from "../../sandbox/exec.js";
import type {
  DepsCacheVolumeSpec,
  ResourceLimits,
  SandboxSession,
  SessionSandbox,
  SessionSpec,
} from "../../sandbox/index.js";
import { abortable } from "../../util/abortable.js";
import { describeError } from "../../util/describe-error.js";
import { DEPENDENCY_EXEC_OPTIONS } from "../deps.js";

const log = logger.child({ component: "skills.register-session" });

/** Beyond a session's own budget, before the reaper may take it. */
const SESSION_EXPIRY_MARGIN_MS = 60_000;

/** A reply exec's stdout carries one line; what the code it runs prints goes to stderr. */
const MAX_REPLY_BYTES = 1024 * 1024;

/** How much of a reply exec's stderr a failure quotes. */
const STDERR_TAIL_BYTES = 4096;

/** Where register's sessions run: a client and the skills image. */
export interface SkillsSessionHost {
  sandbox: SessionSandbox;
  image: string;
}

/** One of register's short-lived sessions of the skills image. */
export interface OneShotSessionSpec {
  /** Names the session in a failure: `<name> session did not start`. */
  name: string;
  network: SessionSpec["network"];
  depsCacheVolume: DepsCacheVolumeSpec | undefined;
  resourceLimits: ResourceLimits;
  /** What its execs may take in all; its expiry adds a margin for the reaper. */
  budgetMs: number;
}

/**
 * Run `use` in a fresh session of the skills image, deleted whatever the
 * outcome, and never past `signal`. A session that cannot start errs with
 * `unavailable` of its reason.
 */
export async function withOneShotSession<T, E>(
  host: SkillsSessionHost,
  spec: OneShotSessionSpec,
  signal: AbortSignal | undefined,
  unavailable: (message: string) => E,
  use: (session: SandboxSession, taskId: string) => Promise<Result<T, E>>,
): Promise<Result<T, E>> {
  // A bare UUID: Local-Docker names the session's cgroup slice after it.
  const taskId = randomUUID();
  let session: SandboxSession;
  try {
    signal?.throwIfAborted();
    // A pull or snapshot build can run long and takes no signal. It holds
    // nothing for this call, so an abort only stops the wait.
    const image = host.sandbox.ensureImagePresent(host.image, spec.resourceLimits);
    await (signal ? abortable(image, signal) : image);
    session = await host.sandbox.create({
      taskId,
      image: host.image,
      resourceLimits: spec.resourceLimits,
      expiresAt: new Date(Date.now() + spec.budgetMs + SESSION_EXPIRY_MARGIN_MS),
      network: spec.network,
      ...(spec.depsCacheVolume && { depsCacheVolume: spec.depsCacheVolume }),
    });
  } catch (e) {
    return err(unavailable(`${spec.name} session did not start: ${describeError(e)}`));
  }
  try {
    return await use(session, taskId);
  } finally {
    await host.sandbox.delete(session).catch((e: unknown) => {
      log.warn({ taskId, session: spec.name, err: describeError(e) }, "sandbox.delete failed");
    });
  }
}

/** Why an exec gave no reply. */
export type ReplyExecError =
  /** It wrote past the reply's cap: the code it ran is the cause. */
  | { kind: "overflow"; message: string }
  /** It did not start, failed, timed out or ended with no reply. */
  | { kind: "failed"; message: string };

/**
 * Run `argv` in `session`, sending `stdin`, and read its one reply: the last
 * line of its stdout, split at `\r` as well as `\n`, parsed with `schema`.
 * `label` names the exec in a failure (`the import`), which quotes the tail of
 * its stderr.
 */
export async function execForReply<R>(
  session: SandboxSession,
  params: {
    argv: readonly string[];
    stdin: string;
    schema: z.ZodType<R>;
    timeoutMs: number;
    signal: AbortSignal | undefined;
    label: string;
  },
): Promise<Result<R, ReplyExecError>> {
  const { label } = params;
  const failed = (message: string): ReplyExecError => ({ kind: "failed", message });
  const handle = await ResultAsync.fromPromise(
    session.execStreaming(params.argv, {
      workingDir: DEPENDENCY_EXEC_OPTIONS.workingDir,
      attachStdin: true,
      timeoutMs: params.timeoutMs,
      ...(params.signal && { signal: params.signal }),
    }),
    (e) => failed(`${label} did not start: ${describeError(e)}`),
  );
  if (handle.isErr()) return err(handle.error);
  const exec = handle.value;
  try {
    const stdin = exec.stdin;
    if (stdin === undefined) return err(failed(`${label}'s exec has no stdin`));
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let overflowed = false;
    let stderr = "";
    let streamError: Error | undefined;
    const captureError = (e: Error): void => {
      streamError ??= e;
    };
    exec.stdout.on("error", captureError);
    exec.stderr.on("error", captureError);
    stdin.on("error", captureError);
    exec.stdout.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_REPLY_BYTES) {
        overflowed = true;
        void exec.dispose().catch(logDisposeFailure);
        return;
      }
      stdout.push(chunk);
    });
    exec.stderr.setEncoding("utf-8");
    exec.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    stdin.end(params.stdin);

    const exited = await exec.exited;
    if (overflowed) {
      return err({
        kind: "overflow",
        message: `${label} wrote more than ${MAX_REPLY_BYTES} bytes to stdout`,
      });
    }
    if (exited.isErr()) return err(failed(describeExecFailure(label, exited.error, stderr)));
    if (streamError) return err(failed(`${label}'s streams failed: ${streamError.message}`));
    // The reply is the last line, split at a carriage return too: a PTY-backed
    // exec ends lines `\r\n` and can put control bytes ahead of the reply on
    // its line, and a JSON reply holds no raw `\r`.
    const lastLine =
      Buffer.concat(stdout)
        .toString("utf-8")
        .split(/[\r\n]+/)
        .findLast((line) => line.trim() !== "") ?? "";
    const reply = parseReply(params.schema, lastLine);
    if (reply !== undefined) return ok(reply);
    const tail = stderr.trim();
    return err(
      failed(`${label} exited ${exited.value.exitCode} with no reply${tail ? `: ${tail}` : ""}`),
    );
  } finally {
    await exec.dispose().catch(logDisposeFailure);
  }
}

function logDisposeFailure(e: unknown): void {
  log.warn({ err: describeError(e) }, "exec.dispose failed");
}

/** The reply on `line`, or undefined when it holds none. */
function parseReply<R>(schema: z.ZodType<R>, line: string): R | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function describeExecFailure(label: string, failure: ExecFailure, stderr: string): string {
  const reason = match(failure)
    .with({ kind: "timed_out" }, ({ timeoutMs }) => `${label} timed out after ${timeoutMs}ms`)
    .with({ kind: "disposed" }, () => `${label} was stopped`)
    .with({ kind: "transport_failed" }, ({ error }) => `${label}'s exec failed: ${error.message}`)
    .with({ kind: "no_exit_code" }, ({ reason }) => `${label} ended with no exit code: ${reason}`)
    .exhaustive();
  const tail = stderr.trim();
  return tail ? `${reason}: ${tail}` : reason;
}
