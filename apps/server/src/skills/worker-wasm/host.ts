import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import * as R from "remeda";
import { match, P } from "ts-pattern";
import { z } from "zod";
import { logger } from "../../logger.js";
import {
  type CtxHandler,
  Dispatcher,
  type GateOutcome,
  unreportedTaskKind,
} from "../dispatcher.js";
import {
  type DispatchGate,
  fromTaskResult,
  type TaskOutcome,
  type TaskRun,
  withheldOutcome,
} from "../protocol.js";
import { SkillInputsSchema, SkillIoSchema } from "../types.js";
import { timeoutSignal } from "../wall-clock.js";
import type { StartFailure, WorkerFrame } from "../worker-state.js";
import { type ChildInit, ProbeReplySchema, SchemaReplySchema } from "./child-protocol.js";
import { INTERRUPT_MESSAGE } from "./interrupt-message.js";
import { killChildGroup, recordChildGroup, removeChildGroupRecord } from "./process-groups.js";
import { createIpcTransport, type IpcChannel } from "./transport.js";
import type {
  ImportedSchemas,
  SchemaImportError,
  WasmPackages,
  WasmProbe,
  WasmProbeError,
  WasmSchemaImporter,
} from "./wasm.js";

/**
 * The wasm host (design/skills.md → Wasm-tier boundary). Each task runs in a
 * child process forked under the permission model with an empty environment;
 * its main thread relays IPC to a Pyodide worker thread capped in memory,
 * with minimal `jsglobals` and no network APIs. The child leads its own
 * process group, recorded under the host's children directory until it exits.
 *
 * The child is plain JavaScript in both modes, since it can resolve nothing
 * outside its grants and tsx cannot run under `--permission`. The build emits
 * `dist/wasm-child.mjs` and `dist/wasm-pyodide-worker.mjs` beside the
 * bundled host (`tsup.config.ts`). From source (dev, tests), the host bundles
 * the same two files with esbuild into a temporary directory on its first
 * spawn (`child-bundle.ts`).
 */

const log = logger.child({ component: "skills.worker.wasm" });

/** Grace window after the interrupt before the child's group is killed. */
const TERMINATE_GRACE_MS = 1000;

/** Child start + Pyodide boot (~1 s) + built-ins and wheels from local files. */
const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** Bounds a probe: Pyodide's boot and every package's load and import. */
const PROBE_TIMEOUT_MS = 60_000;

/** WebAssembly memory a task gets when its manifest declares no `resources.memory_mb`. */
export const DEFAULT_WASM_MEMORY_MB = 128;

/** The `pyodide` package directory, by its real path: the permission model grants real paths. */
const PYODIDE_DIST_DIR = realpathSync(
  dirname(createRequire(import.meta.url).resolve("pyodide/package.json")),
);

/** The real path of the Pyodide distribution every wasm child loads. */
export function pyodideDistDir(): string {
  return PYODIDE_DIST_DIR;
}

export interface RunOnWorkerParams {
  taskId: string;
  run: TaskRun;
  /** Skill name — informational only; surfaced in logs. */
  skillName: string;
  /** Source of `skill.py`. */
  body: string;
  inputs: unknown;
  /** Wall-clock cap in seconds (`wallClockSOf`), the one `deadline_at` counts from. */
  wallClockS: number;
  /** Child init cap (fork, Pyodide boot, package installs). Defaults to 60 s. */
  readyTimeoutMs?: number;
  /** Pyodide's package cache, which the host fills and verifies (`fillBuiltinCache`). */
  packageCacheDir: string;
  /** What the child installs before `ready`, from local files only. */
  packages: WasmPackages;
  /** {@link pyodideDistDir}. */
  pyodideDistDir: string;
  /** Where the child's process-group record lives while it runs. */
  childrenDir: string;
  /** WebAssembly memory ceiling, in MiB. */
  memoryMb: number;
  ctxHandler: CtxHandler;
  /** Asked once the child is ready, immediately before `task_invoke` is sent. */
  dispatch: DispatchGate;
}

/**
 * A wasm task's outcome. The child sends no `rusage`: nothing measures
 * the WebAssembly heap's peak today.
 */
export type RunOnWorkerResult = TaskOutcome;

/** A forked wasm child, as `runOnChild` drives it. */
export interface WasmChild {
  ipc: IpcChannel;
  /** Ask the child to raise `KeyboardInterrupt` in the running Python. */
  interrupt(): void;
  /** `SIGKILL` the child's process group, unless the child has exited. */
  kill(): void;
  /** Settles once the child has exited and its record is deleted. */
  exited: Promise<void>;
}

/** The parts of {@link RunOnWorkerParams} that drive a task on a running child. */
type TaskParams = Pick<
  RunOnWorkerParams,
  | "taskId"
  | "run"
  | "skillName"
  | "inputs"
  | "wallClockS"
  | "readyTimeoutMs"
  | "ctxHandler"
  | "dispatch"
>;

/**
 * Fork a wasm child for one task, drive it through a `Dispatcher` under the
 * wall clock, and kill it. At the wall clock the host asks the child to
 * interrupt the running Python; at the end of the grace window, or as soon
 * as the task settles, it kills the child's group, which a loop with no
 * JS↔WASM boundary cannot outlast.
 */
export async function runOnWorker(params: RunOnWorkerParams): Promise<RunOnWorkerResult> {
  const forked = await forkRunChild(params);
  return forked.match(
    (child) => runOnChild(child, params),
    (reason) =>
      Promise.resolve({
        ok: false,
        errorKind: "runtime_unavailable",
        error: `worker init failed: ${reason}`,
      }),
  );
}

/**
 * Fork the child that runs `params`'s task, under the boundary's flags with
 * read access to the Pyodide distribution, the package cache, the wheel
 * directory and the child bundle only.
 *
 * @public Exported for `host.test.ts`, which forks a child and drops its IPC channel.
 */
export async function forkRunChild(params: RunOnWorkerParams): Promise<Result<WasmChild, string>> {
  const launch = await skillChildLaunch("run", params);
  if (launch.isErr()) return err(launch.error);
  return forkWasmChild({ ...launch.value, childrenDir: params.childrenDir });
}

/**
 * How a child that loads a skill starts: under the boundary's flags with read
 * access to the Pyodide distribution, the package cache, the wheel directory
 * and the child bundle only.
 */
async function skillChildLaunch(
  mode: "run" | "schema",
  params: Pick<
    RunOnWorkerParams,
    "pyodideDistDir" | "packageCacheDir" | "packages" | "memoryMb" | "body"
  >,
): Promise<Result<{ entry: string; execArgv: string[]; init: ChildInit }, string>> {
  const built = await wasmChildEntry();
  if (built.isErr()) return err(built.error);
  const entry = built.value;
  // The child is told the resolved paths it is granted: the permission model
  // compares a path as written, so a granted directory reached through a
  // symlink is refused.
  const resolved = await ResultAsync.combine([
    resolveDir(params.pyodideDistDir, { create: false }),
    resolveDir(dirname(entry), { create: false }),
    resolveDir(params.packageCacheDir, { create: true }),
    params.packages.wheelDir === null
      ? okAsync(null)
      : resolveDir(params.packages.wheelDir, { create: false }),
  ]);
  if (resolved.isErr()) return err(resolved.error);
  const [distDir, entryDir, packageCacheDir, wheelDir] = resolved.value;
  return ok({
    entry,
    execArgv: boundaryExecArgv([
      distDir,
      entryDir,
      packageCacheDir,
      ...(wheelDir === null ? [] : [wheelDir]),
    ]),
    init: {
      mode,
      pyodideDistDir: distDir,
      packageCacheDir,
      builtins: [...params.packages.builtins],
      wheelDir,
      memoryMb: params.memoryMb,
      body: params.body,
    },
  });
}

/**
 * Drive `child` through its handshake and its one task, then make sure it is
 * dead and its record gone. `runOnWorker` hands it a forked child; tests hand
 * it a stand-in.
 *
 * @public Exported for `host.child.test.ts`, which drives it with a stand-in child.
 */
export async function runOnChild(child: WasmChild, params: TaskParams): Promise<RunOnWorkerResult> {
  const readyTimeoutMs = params.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  try {
    const opened = await Dispatcher.open({
      transport: createIpcTransport(child.ipc),
      handshake: acceptWorkerReady,
      // The task's own deadline starts only after the handshake.
      handshakeDeadline: timeoutSignal(readyTimeoutMs),
      logContext: { taskId: params.taskId },
    });
    return await opened.match(
      (dispatcher) => runTask(dispatcher, params, child),
      (failure) =>
        Promise.resolve({
          ok: false,
          errorKind: "runtime_unavailable",
          error: describeStartFailure(failure, readyTimeoutMs),
        }),
    );
  } finally {
    child.kill();
    await child.exited;
  }
}

/**
 * Run the child's one task under the wall clock once its gate lets it
 * through, then close its channel.
 */
async function runTask(
  dispatcher: Dispatcher,
  params: TaskParams,
  child: WasmChild,
): Promise<RunOnWorkerResult> {
  try {
    // Refused only if the child died since its handshake; the invoke then
    // fails the task as a value, unsent.
    void dispatcher.tryAcquire();
    const gate = await dispatcher.gate(params.dispatch);
    return await match(gate)
      .returnType<Promise<RunOnWorkerResult>>()
      .with({ kind: "withhold" }, async () => withheldOutcome())
      .with({ kind: P.union("send", "not_admitted") }, (taken) =>
        sendTask(dispatcher, params, child, taken),
      )
      .exhaustive();
  } finally {
    dispatcher.close("finished");
  }
}

/** Send the task under the wall clock, interrupting the child when it passes. */
async function sendTask(
  dispatcher: Dispatcher,
  params: TaskParams,
  child: WasmChild,
  gate: Exclude<GateOutcome, { kind: "withhold" }>,
): Promise<RunOnWorkerResult> {
  const { wallClockS } = params;
  const lost = unreportedTaskKind(gate);
  const finished = new AbortController();
  try {
    const wallClock = timeoutSignal(wallClockS * 1000);
    wallClock.addEventListener(
      "abort",
      () => {
        log.warn(
          { taskId: params.taskId, skillName: params.skillName, wallClockS },
          "wall-clock exceeded — interrupting wasm child",
        );
        child.interrupt();
      },
      { once: true, signal: finished.signal },
    );
    const { result } = await dispatcher.invoke(
      {
        type: "task_invoke",
        id: params.taskId,
        run: params.run,
        skill: params.skillName,
        inputs: params.inputs,
      },
      {
        ctxHandler: params.ctxHandler,
        deadline: timeoutSignal(wallClockS * 1000 + TERMINATE_GRACE_MS),
      },
    );
    // Whatever arrives once the interrupt was sent is the wall clock's doing,
    // a result included: a skill can catch `KeyboardInterrupt` and return.
    if (wallClock.aborted) {
      return { ok: false, errorKind: "wall_clock_exceeded", error: "wall_clock_exceeded" };
    }
    return result.match(fromTaskResult, (failure) =>
      match(failure)
        .returnType<RunOnWorkerResult>()
        .with({ kind: "timed_out" }, () => ({
          ok: false,
          errorKind: "wall_clock_exceeded",
          error: "wall_clock_exceeded",
        }))
        .with({ kind: "failed" }, ({ reason }) => ({ ok: false, errorKind: lost, error: reason }))
        .with({ kind: "exited_without_result" }, () => ({
          ok: false,
          errorKind: lost,
          error: "task_exited_without_result",
        }))
        .exhaustive(),
    );
  } finally {
    finished.abort();
  }
}

/** The child's first frame: `ready` once Pyodide has loaded, `fatal` if it could not. */
function acceptWorkerReady(first: WorkerFrame): Result<void, string> {
  return match(first)
    .with({ type: "ready" }, () => ok(undefined))
    .with({ type: "fatal" }, ({ error }) => err(`worker init failed: ${error}`))
    .with({ type: "malformed" }, ({ issues }) =>
      err(`worker sent a malformed frame before ready (${issues.join("; ")})`),
    )
    .otherwise(({ type }) => err(`worker sent ${type} before ready`));
}

function describeStartFailure(failure: StartFailure, readyTimeoutMs: number): string {
  return match(failure)
    .with({ kind: "refused" }, ({ reason }) => reason)
    .with({ kind: "timed_out" }, () => `worker_init_timeout after ${readyTimeoutMs}ms`)
    .with({ kind: "ended" }, ({ reason }) => `worker init failed: ${reason}`)
    .with({ kind: "closed" }, ({ reason }) => `worker closed before ready: ${reason}`)
    .exhaustive();
}

export interface WasmProbeOptions {
  /** {@link pyodideDistDir}. */
  pyodideDistDir: string;
  /** Where each child's process-group record lives while it runs. */
  childrenDir: string;
}

/**
 * A schema import's budget: a child's start and package load, then the
 * skill's module code under its run's wall clock.
 */
export function wasmSchemaImportTimeoutMs(wallClockS: number): number {
  return DEFAULT_READY_TIMEOUT_MS + wallClockS * 1000;
}

/**
 * The {@link WasmProbe} over wasm children. A probe child runs under the
 * same flags as a task's, reads the package cache the host filled and
 * verified, runs no skill code, and is time-boxed by its signal and a
 * default.
 */
export function createWasmProbe(opts: WasmProbeOptions): WasmProbe {
  return {
    async probeBuiltins(names, { packageCacheDir, signal }) {
      const unavailable = (message: string): WasmProbeError => ({ kind: "unavailable", message });
      const entry = await wasmChildEntry();
      if (entry.isErr()) return err(unavailable(entry.error));
      const grants = await ResultAsync.combine([
        resolveDir(opts.pyodideDistDir, { create: false }),
        resolveDir(dirname(entry.value), { create: false }),
        resolveDir(packageCacheDir, { create: false }),
      ]);
      if (grants.isErr()) return err(unavailable(grants.error));
      const [, , cacheDir] = grants.value;
      const reply = await runUtilityChild(opts, {
        entry: entry.value,
        init: {
          mode: "probe",
          pyodideDistDir: opts.pyodideDistDir,
          packageCacheDir: cacheDir ?? packageCacheDir,
          names: [...names],
        },
        execArgv: boundaryExecArgv(grants.value),
        timeoutMs: PROBE_TIMEOUT_MS,
        signal,
        schema: ProbeReplySchema,
      });
      return reply
        .mapErr((reason) => unavailable(`probe failed: ${reason}`))
        .andThen((r) =>
          match(r)
            .returnType<Result<void, WasmProbeError>>()
            .with({ type: "probed" }, ({ failures }) =>
              failures.length === 0 ? ok(undefined) : err({ kind: "rejected", failures }),
            )
            .with({ type: "fatal" }, ({ error }) => err(unavailable(`probe failed: ${error}`)))
            .exhaustive(),
        );
    },
  };
}

/**
 * The {@link WasmSchemaImporter} over wasm children. A schema child starts as
 * a task's does, under the boundary's flags, the memory cap and the skill's
 * packages, imports the skill and replies with its models' JSON Schemas; the
 * host parses `inputs` as an object schema and `outputs` as a JSON object.
 */
export function createWasmSchemaImporter(opts: WasmProbeOptions): WasmSchemaImporter {
  return {
    async importSchemas(params) {
      const unavailable = (message: string): SchemaImportError => ({
        kind: "unavailable",
        message,
      });
      const launch = await skillChildLaunch("schema", {
        ...params,
        pyodideDistDir: opts.pyodideDistDir,
      });
      if (launch.isErr()) return err(unavailable(launch.error));
      const reply = await runUtilityChild(opts, {
        entry: launch.value.entry,
        init: launch.value.init,
        execArgv: launch.value.execArgv,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        schema: SchemaReplySchema,
      });
      return reply
        .mapErr((reason) => unavailable(`schema import failed: ${reason}`))
        .andThen((r) =>
          match(r)
            .returnType<Result<ImportedSchemas, SchemaImportError>>()
            .with({ type: "schemas" }, ({ inputs, outputs }) => importedSchemas(inputs, outputs))
            .with({ type: "schema_failed" }, ({ error }) =>
              err({ kind: "refused", message: error }),
            )
            .with({ type: "fatal" }, ({ error }) =>
              err(unavailable(`worker init failed: ${error}`)),
            )
            .exhaustive(),
        );
    },
  };
}

/**
 * The child's schemas, parsed: `inputs` must be an object schema. `outputs`
 * crossed JSON IPC as an object, so it is one, and a failed parse is a bug.
 */
function importedSchemas(
  inputs: Record<string, unknown> | null,
  outputs: Record<string, unknown> | null,
): Result<ImportedSchemas, SchemaImportError> {
  const parsedInputs = inputs === null ? null : SkillInputsSchema.safeParse(inputs);
  if (parsedInputs !== null && !parsedInputs.success) {
    return err({
      kind: "refused",
      message: `Input's JSON Schema does not describe an object: ${z.prettifyError(parsedInputs.error)}`,
    });
  }
  return ok({
    inputs: parsedInputs?.data ?? null,
    outputs: outputs === null ? null : SkillIoSchema.parse(outputs),
  });
}

/**
 * Fork a child, take its one reply, and kill it. Errs when the child cannot
 * start, exits first, replies with something else, or outlives `timeoutMs` or
 * `signal`.
 */
async function runUtilityChild<T>(
  opts: WasmProbeOptions,
  run: {
    /** The child bundle (`wasmChildEntry`). */
    entry: string;
    init: ChildInit;
    execArgv: readonly string[];
    timeoutMs: number;
    signal: AbortSignal | undefined;
    schema: z.ZodType<T>;
  },
): Promise<Result<T, string>> {
  const forked = await forkWasmChild({
    entry: run.entry,
    execArgv: run.execArgv,
    init: run.init,
    childrenDir: opts.childrenDir,
  });
  if (forked.isErr()) return err(forked.error);
  const child = forked.value;
  try {
    const deadline = AbortSignal.any([
      timeoutSignal(run.timeoutMs),
      ...(run.signal === undefined ? [] : [run.signal]),
    ]);
    const reply = await firstMessage(child.ipc, deadline);
    return reply.andThen((raw) => {
      const parsed = run.schema.safeParse(raw);
      return parsed.success ? ok(parsed.data) : err(`malformed reply: ${parsed.error.message}`);
    });
  } finally {
    child.kill();
    await child.exited;
  }
}

/**
 * The child's first message, or why none came before it exited and its
 * channel closed, or `deadline` aborted.
 */
function firstMessage(ipc: IpcChannel, deadline: AbortSignal): Promise<Result<unknown, string>> {
  return new Promise((resolve) => {
    const settle = (result: Result<unknown, string>): void => {
      ipc.off("message", onMessage);
      ipc.off("close", onClose);
      deadline.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onMessage = (message: unknown): void => settle(ok(message));
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void =>
      settle(err(`child exited (${code === null ? `signal ${signal}` : `code ${code}`})`));
    const onAbort = (): void => settle(err(`aborted: ${describeReason(deadline.reason)}`));
    if (deadline.aborted) {
      onAbort();
      return;
    }
    ipc.on("message", onMessage);
    ipc.on("close", onClose);
    deadline.addEventListener("abort", onAbort, { once: true });
  });
}

function describeReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The child's launch flags (design/skills.md → layer 1). `--permission` with
 * read grants for `grants` and nothing else: no writes, no child processes,
 * no network, no addons; `--allow-worker` for the Pyodide thread; and no JS
 * built from strings, which closes the `Function` constructor every JS proxy
 * reaches. Node prints a warning for `--allow-worker` in every child; it is
 * the design, so it is silenced.
 */
function boundaryExecArgv(grants: readonly string[]): string[] {
  return [
    "--permission",
    ...grants.map((dir) => `--allow-fs-read=${dir}`),
    "--allow-worker",
    "--disallow-code-generation-from-strings",
    "--disable-warning=SecurityWarning",
  ];
}

/** The real path of `dir`, made first when `create`: the permission model grants real paths. */
function resolveDir(dir: string, opts: { create: boolean }): ResultAsync<string, string> {
  return ResultAsync.fromPromise(
    (async () => {
      if (opts.create) await mkdir(dir, { recursive: true });
      return realpath(dir);
    })(),
    (e) => `cannot grant ${dir}: ${describeReason(e)}`,
  );
}

/**
 * Fork a wasm child, leading its own process group with only the IPC
 * channel and stderr inherited, record the group before anything else, and
 * send it `init`. A child whose group cannot be recorded is killed: a reap
 * could not find it.
 */
async function forkWasmChild(opts: {
  entry: string;
  execArgv: readonly string[];
  init: ChildInit;
  childrenDir: string;
}): Promise<Result<WasmChild, string>> {
  const childrenDir = await ResultAsync.fromPromise(
    mkdir(opts.childrenDir, { recursive: true }),
    (e) => `cannot create ${opts.childrenDir}: ${describeReason(e)}`,
  );
  if (childrenDir.isErr()) return err(childrenDir.error);

  const child = fork(opts.entry, [], {
    execArgv: [...opts.execArgv],
    env: {},
    // stderr is the host's stderr descriptor; the permission model does not
    // cover inherited descriptors, so it is the only one besides the channel.
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    detached: true,
    serialization: "json",
  });
  // A send racing the child's exit errors here as well as in the transport.
  child.on("error", (e) => log.debug({ err: e.message }, "wasm child error"));
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const pid = child.pid;
  if (pid === undefined) {
    const [e] = await once(child, "error");
    return err(`cannot fork the wasm child: ${describeReason(e)}`);
  }
  // Alive until its exit is reaped, so its pid still names its group.
  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) killChildGroup(pid);
  };

  const recorded = await recordChildGroup(opts.childrenDir, pid);
  if (recorded.isErr()) {
    kill();
    await exit;
    return err(recorded.error);
  }
  const exited = exit.then(() => removeChildGroupRecord(recorded.value));
  child.send(opts.init);
  return ok({
    ipc: child,
    interrupt: () => {
      if (child.connected) child.send(INTERRUPT_MESSAGE);
    },
    kill,
    exited,
  });
}

let sourceBundle: Promise<Result<string, string>> | undefined;

/**
 * The child entry: beside the bundled host, or bundled from source on first
 * use. A failed build, or a published bundle this user cannot trust, errs; it
 * is not kept, so the next spawn builds again.
 */
function wasmChildEntry(): Promise<Result<string, string>> {
  if (!import.meta.url.endsWith(".ts")) {
    return Promise.resolve(ok(fileURLToPath(new URL("./wasm-child.mjs", import.meta.url))));
  }
  if (sourceBundle !== undefined) return sourceBundle;
  const building = buildSourceEntry();
  sourceBundle = building;
  void building.then((built) => {
    if (built.isErr() && sourceBundle === building) sourceBundle = undefined;
  });
  return building;
}

/** {@link bundleFromSource}, whose failures (esbuild, the filesystem, `assertOwnPrivateDir`) all leave the child unbuilt. */
async function buildSourceEntry(): Promise<Result<string, string>> {
  return ResultAsync.fromPromise(
    bundleFromSource(),
    (e) => `cannot build the wasm child: ${describeReason(e)}`,
  );
}

/**
 * Bundle the child from source into a temporary directory named by the
 * bundle's digest, so test files and dev restarts share one copy per version
 * of the sources rather than leave one behind each. The first process to
 * publish a digest wins; a later one drops its own build and uses the
 * winner's only if it is this user's private directory, since anyone can
 * create a name in the shared temporary directory first.
 */
async function bundleFromSource(): Promise<string> {
  const { buildWasmChild, assertOwnPrivateDir } = await import("./child-bundle.js");
  const root = await realpath(tmpdir());
  const buildDir = await mkdtemp(join(root, "cogmo-wasm-build-"));
  try {
    await buildWasmChild({
      sourceDir: fileURLToPath(new URL(".", import.meta.url)),
      outDir: buildDir,
    });
  } catch (e) {
    await rm(buildDir, { recursive: true, force: true });
    throw e;
  }
  const files = (await readdir(buildDir)).sort();
  const contents = await Promise.all(files.map((f) => readFile(join(buildDir, f))));
  const digest = R.reduce(
    R.zip(files, contents),
    (hash, [file, content]) => hash.update(file).update(content),
    createHash("sha256"),
  ).digest("hex");
  const outDir = join(root, `cogmo-wasm-child-${digest.slice(0, 16)}`);
  try {
    await rename(buildDir, outDir);
  } catch (e) {
    const code = e instanceof Error && "code" in e ? e.code : undefined;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw e;
    await rm(buildDir, { recursive: true, force: true });
    await assertOwnPrivateDir(outDir);
  }
  return join(outDir, "wasm-child.mjs");
}
