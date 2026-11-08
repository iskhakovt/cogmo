import { randomUUID } from "node:crypto";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import type { ExecFailure } from "../../sandbox/exec.js";
import type {
  DepsCacheVolumeSpec,
  ResourceLimits,
  SandboxClient,
  SandboxSession,
  SessionSpec,
} from "../../sandbox/index.js";
import { abortable } from "../../util/abortable.js";
import { describeError } from "../../util/describe-error.js";
import {
  DEFAULT_DEPENDENCY_SESSION_LIMITS,
  DEPENDENCY_EXEC_OPTIONS,
  ensureVenvPopulated,
  type LockfileSnapshot,
} from "../deps.js";
import { type SchemaImportReply, SchemaImportReplySchema } from "../protocol.js";
import {
  type ImportedSchemas,
  type SchemaImportError,
  schemaImportResult,
} from "../schema-import.js";

const log = logger.child({ component: "skills.schema-import" });

/** The import's stdout carries one reply line; module code's prints go to stderr. */
const MAX_REPLY_BYTES = 1024 * 1024;

/** How much of the import's stderr a failure quotes. */
const STDERR_TAIL_BYTES = 4096;

/** Beyond a session's own budget, before the reaper may take it. */
const SESSION_EXPIRY_MARGIN_MS = 60_000;

/** Install budget: the populate's, a cold sync of a large tree included. */
const INSTALL_TIMEOUT_MS = 180_000;

/** The container tier's schema import at register (design/skills.md → Contracts). */
export interface ContainerSchemaImporter {
  /**
   * Import `body` and read its models' JSON Schemas. With a lockfile, an
   * install session populates its venv on the shared volume first, with
   * network to reach the index; the import session is created with no
   * network and activates that venv. Neither session outlives `signal`.
   */
  importSchemas(params: {
    body: string;
    lockfile: LockfileSnapshot | null;
    /** The skill's own limits, over the dependency sessions' defaults. */
    resourceLimits: Partial<ResourceLimits>;
    /** The import's budget: the run's wall clock. */
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Result<ImportedSchemas, SchemaImportError>>;
}

export interface SandboxSchemaImporterOptions {
  sandbox: SandboxClient;
  image: string;
  /**
   * The shared venv volume, which carries the install session's venv to the
   * import session; a lockfile without it is a caller bug.
   */
  depsCacheVolumeName: string | undefined;
}

/** The {@link ContainerSchemaImporter} over sandbox sessions of the skills image. */
export function makeSandboxSchemaImporter(
  opts: SandboxSchemaImporterOptions,
): ContainerSchemaImporter {
  return {
    async importSchemas(params) {
      const { lockfile, signal } = params;
      if (lockfile !== null && opts.depsCacheVolumeName === undefined) {
        throw new Error("schema import: a lockfile needs the shared venv volume");
      }
      const depsCacheVolume =
        lockfile === null || opts.depsCacheVolumeName === undefined
          ? undefined
          : { volumeName: opts.depsCacheVolumeName };
      if (lockfile !== null && depsCacheVolume !== undefined) {
        const installed = await withSession(
          opts,
          {
            name: "schema-install",
            network: "bridge",
            depsCacheVolume,
            resourceLimits: DEFAULT_DEPENDENCY_SESSION_LIMITS,
            budgetMs: INSTALL_TIMEOUT_MS,
          },
          signal,
          (session, taskId) => install(session, lockfile, taskId),
        );
        if (installed.isErr()) return err(installed.error);
      }
      const reply = await withSession(
        opts,
        {
          name: "schema-import",
          network: "none",
          depsCacheVolume,
          resourceLimits: { ...DEFAULT_DEPENDENCY_SESSION_LIMITS, ...params.resourceLimits },
          budgetMs: params.timeoutMs,
        },
        signal,
        (session) => runImport(session, { ...params, lockfileHash: lockfile?.hash ?? null }),
      );
      return reply.andThen((r) =>
        schemaImportResult(r, (error) => `the import did not start: ${error}`),
      );
    },
  };
}

/**
 * Run `use` in a fresh session of the skills image, deleted whatever the
 * outcome. A session that cannot start is `unavailable`.
 */
async function withSession<T>(
  opts: SandboxSchemaImporterOptions,
  spec: {
    name: string;
    network: SessionSpec["network"];
    depsCacheVolume: DepsCacheVolumeSpec | undefined;
    resourceLimits: ResourceLimits;
    budgetMs: number;
  },
  signal: AbortSignal | undefined,
  use: (session: SandboxSession, taskId: string) => Promise<Result<T, SchemaImportError>>,
): Promise<Result<T, SchemaImportError>> {
  const taskId = `${spec.name}-${randomUUID()}`;
  let session: SandboxSession;
  try {
    signal?.throwIfAborted();
    const image = opts.sandbox.ensureImagePresent(opts.image, spec.resourceLimits);
    await (signal ? abortable(image, signal) : image);
    session = await opts.sandbox.create({
      taskId,
      image: opts.image,
      resourceLimits: spec.resourceLimits,
      expiresAt: new Date(Date.now() + spec.budgetMs + SESSION_EXPIRY_MARGIN_MS),
      network: spec.network,
      ...(spec.depsCacheVolume && { depsCacheVolume: spec.depsCacheVolume }),
    });
  } catch (e) {
    return err({
      kind: "unavailable",
      message: `${spec.name} session did not start: ${describeError(e)}`,
    });
  }
  try {
    return await use(session, taskId);
  } finally {
    await opts.sandbox.delete(session).catch((e: unknown) => {
      log.warn({ taskId, err: describeError(e) }, "schema import: sandbox.delete failed");
    });
  }
}

/** Populate the lockfile's venv; a sync that fails is a verdict on the dependencies. */
async function install(
  session: SandboxSession,
  lockfile: LockfileSnapshot,
  taskId: string,
): Promise<Result<void, SchemaImportError>> {
  const populated = await ensureVenvPopulated({
    session,
    lockfileHash: lockfile.hash,
    lockfileContents: lockfile.contents,
    workerId: taskId,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  return populated.mapErr((e) =>
    match(e)
      .returnType<SchemaImportError>()
      .with({ kind: "populate_failed" }, ({ message }) => ({
        kind: "refused",
        message: `the skill's dependencies did not install: ${message}`,
      }))
      .with({ kind: "transport_failed" }, ({ message }) => ({
        kind: "unavailable",
        message: `the install did not finish: ${message}`,
      }))
      .exhaustive(),
  );
}

/**
 * Run `cogmo_skills_runtime.schema` on the body and read its one reply, the
 * last line of its stdout. A reply past {@link MAX_REPLY_BYTES} is the
 * skill's; an exec that ends without a reply is `unavailable`, quoting its
 * stderr's tail.
 */
async function runImport(
  session: SandboxSession,
  params: { body: string; lockfileHash: string | null; timeoutMs: number; signal?: AbortSignal },
): Promise<Result<SchemaImportReply, SchemaImportError>> {
  const unavailable = (message: string): SchemaImportError => ({ kind: "unavailable", message });
  const handle = await ResultAsync.fromPromise(
    session.execStreaming(
      [
        "python3",
        "-I",
        "-m",
        "cogmo_skills_runtime.schema",
        ...(params.lockfileHash === null ? [] : [params.lockfileHash]),
      ],
      {
        workingDir: DEPENDENCY_EXEC_OPTIONS.workingDir,
        attachStdin: true,
        timeoutMs: params.timeoutMs,
        ...(params.signal && { signal: params.signal }),
      },
    ),
    (e) => unavailable(`the import did not start: ${describeError(e)}`),
  );
  if (handle.isErr()) return err(handle.error);
  const exec = handle.value;
  try {
    const stdin = exec.stdin;
    if (stdin === undefined) return err(unavailable("the import's exec has no stdin"));
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
        void exec.dispose().catch(() => {});
        return;
      }
      stdout.push(chunk);
    });
    exec.stderr.setEncoding("utf-8");
    exec.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    stdin.end(params.body);

    const exited = await exec.exited;
    if (overflowed) {
      return err({
        kind: "refused",
        message: `the import wrote more than ${MAX_REPLY_BYTES} bytes to stdout`,
      });
    }
    if (exited.isErr()) return err(unavailable(describeExecFailure(exited.error, stderr)));
    if (streamError) return err(unavailable(`the import's streams failed: ${streamError.message}`));
    const lastLine = Buffer.concat(stdout).toString("utf-8").trimEnd().split("\n").at(-1) ?? "";
    const reply = parseReply(lastLine);
    if (reply !== undefined) return ok(reply);
    const tail = stderr.trim();
    return err(
      unavailable(
        `the import exited ${exited.value.exitCode} with no reply${tail ? `: ${tail}` : ""}`,
      ),
    );
  } finally {
    await exec.dispose().catch(() => {});
  }
}

/** The reply on `line`, or undefined when it holds none. */
function parseReply(line: string): SchemaImportReply | undefined {
  try {
    const parsed = SchemaImportReplySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function describeExecFailure(failure: ExecFailure, stderr: string): string {
  const reason = match(failure)
    .with({ kind: "timed_out" }, ({ timeoutMs }) => `the import timed out after ${timeoutMs}ms`)
    .with({ kind: "disposed" }, () => "the import was stopped")
    .with({ kind: "transport_failed" }, ({ error }) => `the import's exec failed: ${error.message}`)
    .with({ kind: "no_exit_code" }, ({ reason }) => `the import ended with no exit code: ${reason}`)
    .exhaustive();
  const tail = stderr.trim();
  return tail ? `${reason}: ${tail}` : reason;
}
