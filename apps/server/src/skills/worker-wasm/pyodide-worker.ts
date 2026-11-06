import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type MessagePort, parentPort, workerData } from "node:worker_threads";
import * as nodeZlib from "node:zlib";
import { errAsync, ResultAsync } from "neverthrow";
import type { PyodideInterface } from "pyodide";
import { match } from "ts-pattern";
import {
  CtxResultSchema,
  TaskInvokeSchema,
  type TaskResult,
  type WorkerErrorKind,
} from "../protocol.js";
import { type ChildInit, ChildInitSchema } from "./child-protocol.js";
import CTX_PY from "./py/ctx.py";
import INSTALL_DEPS_PY from "./py/install_deps.py";
import OUTPUT_PY from "./py/output.py";

/**
 * A wasm child's Pyodide worker thread (design/skills.md → Wasm-tier
 * boundary). It inherits the child's permission flags and runs with an empty
 * `env`. In `run` mode it boots Pyodide under the memory cap with minimal
 * `jsglobals`, loads the skill's packages from local files only, deletes the
 * network APIs, signals `ready` and runs one task. In `probe` mode it loads
 * and imports packages from the cache under the same flags and runs no skill
 * code. Neither mode reaches the network: the host fills the cache.
 *
 * The child bundle embeds `py/*.py` as text (`child-bundle.ts`).
 */

interface WorkerData {
  init: unknown;
  interruptBuffer: SharedArrayBuffer;
}

const data: WorkerData = workerData;
const port = requireParentPort();

function requireParentPort(): MessagePort {
  if (parentPort === null) throw new Error("pyodide-worker must run inside a worker thread");
  return parentPort;
}

/** WebAssembly's page size. */
const WASM_PAGE_BYTES = 65_536;

/** Globals deleted before skill code runs, so a hole in the permission model still finds no network API. */
const NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket"] as const;

/** Where the wheel directory is mounted while micropip installs from it. */
const WHEEL_MOUNT = "/wheels";

/**
 * Emscripten's boot calls `process.binding("constants")`, which `--permission`
 * denies, and reads `fs.O_APPEND` and the like from it. The public modules
 * carry the same constants.
 */
function shimProcessBinding(): void {
  const original: (name: string) => unknown = Reflect.get(process, "binding");
  Reflect.set(process, "binding", (name: string) =>
    name === "constants"
      ? {
          os: nodeOs.constants,
          fs: nodeFs.constants,
          zlib: nodeZlib.constants,
          crypto: nodeCrypto.constants,
        }
      : original.call(process, name),
  );
}

/**
 * Cap WebAssembly memory at `memoryMb` (design/skills.md → layer 5). Pyodide
 * grows its heap through `WebAssembly.Memory.prototype.grow` from JS; past the
 * cap the call throws, Emscripten's allocator returns null and Python raises
 * `MemoryError`, and the interpreter carries on. The property is locked so
 * skill code cannot put a plain `grow` back. Measured on Pyodide 314: the
 * heap is 36 MiB once pydantic is loaded and a model validated, so the 128 MiB
 * default leaves ~90 MiB for the skill.
 */
function capWasmMemory(memoryMb: number): void {
  const maxPages = (memoryMb * 1024 * 1024) / WASM_PAGE_BYTES;
  const grow = WebAssembly.Memory.prototype.grow;
  Object.defineProperty(WebAssembly.Memory.prototype, "grow", {
    value: function cappedGrow(this: WebAssembly.Memory, delta: number): number {
      if (this.buffer.byteLength / WASM_PAGE_BYTES + delta > maxPages) {
        throw new RangeError(`WebAssembly memory is capped at ${memoryMb} MiB`);
      }
      return grow.call(this, delta);
    },
    writable: false,
    configurable: false,
  });
}

async function bootPyodide(options: {
  pyodideDistDir: string;
  packageCacheDir: string;
}): Promise<PyodideInterface> {
  // By path, not by package name: the bundle lives outside node_modules.
  const pyodideModule: typeof import("pyodide") = await import(
    pathToFileURL(join(options.pyodideDistDir, "pyodide.mjs")).href
  );
  return pyodideModule.loadPyodide({
    indexURL: options.pyodideDistDir,
    packageCacheDir: options.packageCacheDir,
    // `js` is this object: `setTimeout`/`clearTimeout` for the asyncio loop
    // `ctx` calls await, and nothing else (design/skills.md → layer 3).
    jsglobals: Object.freeze(Object.assign(Object.create(null), { setTimeout, clearTimeout })),
    env: {},
    // A worker thread's stdout and stderr have no descriptor for Pyodide's
    // default writers, and the child's stdout goes nowhere. A skill's output
    // is its return value; a failure's traceback is the task's error.
    stdout: () => {},
    stderr: () => {},
  });
}

/** PEP 503 normalization, the form Pyodide's lockfile keys take. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * Load `names` with their dependencies. Pyodide reports a package it cannot
 * load through `errorCallback` and resolves anyway, so the errors and the
 * loaded set decide: null when every name loaded, the reason otherwise.
 *
 * Under Node, Pyodide checks no integrity: no cached file is compared with
 * the lockfile's sha256, whatever `checkIntegrity` says. The host's check of
 * every file before it enters the package cache (`fillBuiltinCache`) is the
 * one that counts.
 */
async function loadPackages(
  py: PyodideInterface,
  names: readonly string[],
): Promise<string | null> {
  if (names.length === 0) return null;
  const errors: string[] = [];
  const loaded = await py.loadPackage([...names], {
    messageCallback: () => {},
    errorCallback: (message) => errors.push(message),
  });
  const loadedNames = new Set(loaded.map((p) => normalizeName(p.name)));
  const missing = names.filter((n) => !loadedNames.has(normalizeName(n)));
  if (errors.length === 0 && missing.length === 0) return null;
  return [...errors, ...(missing.length > 0 ? [`not loaded: ${missing.join(", ")}`] : [])].join(
    "; ",
  );
}

/**
 * Install every wheel in `wheelDir` with micropip, from a read-only mount and
 * without dependency resolution: the host resolved and hash-checked the set
 * (design/skills.md → layer 4). micropip is a Pyodide built-in the host puts
 * in the cache. `py/install_deps.py` checks each installed version
 * against its wheel's.
 */
async function installWheels(py: PyodideInterface, wheelDir: string): Promise<void> {
  const files = nodeFs.readdirSync(wheelDir).filter((f) => f.endsWith(".whl"));
  if (files.length === 0) return;
  const micropip = await loadPackages(py, ["micropip"]);
  if (micropip !== null) throw new Error(`micropip did not load: ${micropip}`);
  py.FS.mkdirTree(WHEEL_MOUNT);
  py.FS.mount(py.FS.filesystems.NODEFS, { root: wheelDir }, WHEEL_MOUNT);
  try {
    await py.runPythonAsync(INSTALL_DEPS_PY);
    py.globals.set("__cogmo_wheels", files);
    // A top-level `await` isn't valid Python in a module, so it can't live in `py/`.
    await py.runPythonAsync(
      `await _install_wheels("${WHEEL_MOUNT}", list(__cogmo_wheels))\ndel __cogmo_wheels\n`,
    );
  } finally {
    py.FS.unmount(WHEEL_MOUNT);
  }
}

function deleteNetworkGlobals(): void {
  for (const name of NETWORK_GLOBALS) {
    Reflect.deleteProperty(globalThis, name);
    if (name in globalThis) throw new Error(`could not delete globalThis.${name}`);
  }
}

/**
 * A ctx call's answer as it reaches Python. `Ctx._call` in `py/ctx.py` returns
 * the value or raises `CtxError(kind, message)`, the class the container tier raises: a
 * plain value crosses into Pyodide intact, where a rejected promise arrives
 * as a `JsException` carrying only the error's name and message.
 */
type BridgeReply = { ok: true; value: unknown } | { ok: false; kind: string; message: string };

// ctx_call → ctx_result correlation. The Python `ctx` proxy awaits these
// JS Promises, settled when the matching ctx_result arrives.
const pendingCtxCalls = new Map<string, (reply: BridgeReply) => void>();
let nextCtxId = 0;

function callHost(taskId: string, method: string, args: unknown): Promise<BridgeReply> {
  const id = `ctx-${nextCtxId++}`;
  return new Promise((resolve, reject) => {
    pendingCtxCalls.set(id, resolve);
    try {
      port.postMessage({ type: "ctx_call", taskId, id, method, args });
    } catch (e) {
      // `args` would not clone: no reply will come, so fail the awaiting
      // coroutine rather than leave it hung.
      pendingCtxCalls.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function handleCtxResult(raw: unknown): void {
  const parsed = CtxResultSchema.safeParse(raw);
  if (!parsed.success) return;
  const result = parsed.data;
  const resolve = pendingCtxCalls.get(result.id);
  if (!resolve) return;
  pendingCtxCalls.delete(result.id);
  resolve(
    result.ok
      ? { ok: true, value: result.value }
      : { ok: false, kind: result.errorKind, message: result.message },
  );
}

/** A Python value as plain JS: dicts become objects. */
function toPlain(py: PyodideInterface, value: unknown): unknown {
  if (!(value instanceof py.ffi.PyProxy)) return value ?? null;
  return value.toJs({ dict_converter: Object.fromEntries });
}

/** A failed stage of a task: the run error kind it reports, and why. */
interface StageFailure {
  errorKind: WorkerErrorKind;
  error: string;
}

/** Run one stage of a task, reporting a throw as `errorKind`. */
function stage<T>(
  errorKind: (e: unknown) => WorkerErrorKind,
  run: () => T | Promise<T>,
): ResultAsync<T, StageFailure> {
  return ResultAsync.fromPromise(Promise.resolve().then(run), (e) => ({
    errorKind: errorKind(e),
    error: e instanceof Error ? e.message : String(e),
  }));
}

/**
 * How a stage running skill code failed: a `MemoryError` is the memory cap
 * (`capWasmMemory`), at whichever stage it struck; anything else is `kind`.
 */
function skillStageKind(
  py: PyodideInterface,
  kind: WorkerErrorKind,
): (e: unknown) => WorkerErrorKind {
  return (e) =>
    e instanceof py.ffi.PythonError && e.type === "MemoryError" ? "memory_exceeded" : kind;
}

/**
 * Load the ctx SDK and the skill body into module-level globals, run the
 * skill, and encode what it returned. One task runs per child, so
 * module-level globals are safe. The glue between them is inline because it
 * names the bridge module registered here, and because a top-level `await`
 * isn't valid Python in a module, so it can't live in `py/`.
 */
function runTask(
  py: PyodideInterface,
  body: string,
  invoke: { id: string; inputs: unknown },
): ResultAsync<unknown, StageFailure> {
  // Every call names the task: the host serves a ctx call only for the task
  // it belongs to. Python passes its args dict as a proxy, converted here.
  py.registerJsModule("__cogmo_bridge__", {
    bridge: {
      call: (method: string, args: unknown) => callHost(invoke.id, method, toPlain(py, args)),
    },
  });
  return stage(
    () => "runtime_unavailable",
    async () => {
      await py.runPythonAsync(CTX_PY);
      await py.runPythonAsync(OUTPUT_PY);
      await py.runPythonAsync(
        "from __cogmo_bridge__ import bridge as __cogmo_bridge\n_ctx = _build_ctx(__cogmo_bridge)\n",
      );
    },
  )
    .andThen(() =>
      stage(skillStageKind(py, "load_failed"), async () => {
        await py.runPythonAsync(body);
        // Callable, not a coroutine function: a `run` wrapped by a plain
        // decorator still returns the awaitable the next stage awaits.
        if (!py.runPython("callable(globals().get('run'))")) {
          throw new Error("skill must define `async def run(inputs, ctx)`");
        }
      }),
    )
    .andThen(() => {
      py.globals.set("__cogmo_inputs", py.toPy(invoke.inputs));
      return stage(skillStageKind(py, "skill_raised"), () =>
        py.runPythonAsync("__cogmo_result = await run(__cogmo_inputs, _ctx)"),
      );
    })
    .andThen(() =>
      // Encoded in Python, as the container tier does: `NaN`, a `set`, a JS
      // proxy or an integer the host would round is refused here rather than
      // coerced on its way to the host (`py/output.py`).
      stage(skillStageKind(py, "output_invalid"), (): unknown =>
        py.runPython("_cogmo_encode_output(__cogmo_result)"),
      ),
    )
    .andThen((encoded) =>
      // The encoder shares the skill's globals, so what it returns is parsed
      // as the skill's: anything but a JSON string is the skill's output
      // failing, not the worker.
      typeof encoded === "string"
        ? stage(
            () => "output_invalid",
            (): unknown => JSON.parse(encoded),
          )
        : errAsync<unknown, StageFailure>({
            errorKind: "output_invalid",
            error: "the output encoder returned no string",
          }),
    );
}

async function handleTaskInvoke(py: PyodideInterface, body: string, raw: unknown): Promise<void> {
  const parsed = TaskInvokeSchema.safeParse(raw);
  if (!parsed.success) return;
  const invoke = parsed.data;
  const result = await runTask(py, body, invoke).match(
    (output): TaskResult => ({ type: "task_result", id: invoke.id, ok: true, output }),
    ({ errorKind, error }): TaskResult => ({
      type: "task_result",
      id: invoke.id,
      ok: false,
      errorKind,
      error,
    }),
  );
  port.postMessage(result);
}

async function run(init: Extract<ChildInit, { mode: "run" }>): Promise<void> {
  capWasmMemory(init.memoryMb);
  const py = await bootPyodide({
    pyodideDistDir: init.pyodideDistDir,
    packageCacheDir: init.packageCacheDir,
  });
  py.setInterruptBuffer(new Uint8Array(data.interruptBuffer));
  // Wheels first: a lockfile may pin a dependency Pyodide bundles at another
  // version, and micropip records what it installs among the loaded
  // packages, so the built-ins' load below skips the bundled copy rather than
  // overwrite the pin.
  if (init.wheelDir !== null) await installWheels(py, init.wheelDir);
  // A package missing from the cache fails the boot: under the permission
  // model Pyodide's CDN fallback cannot reach the network.
  const builtins = await loadPackages(py, init.builtins);
  if (builtins !== null) throw new Error(`built-in packages did not load: ${builtins}`);
  deleteNetworkGlobals();

  port.on("message", (raw: unknown) => {
    const type = typeof raw === "object" && raw !== null && "type" in raw ? raw.type : undefined;
    match(type)
      .with("ctx_result", () => handleCtxResult(raw))
      .with("task_invoke", () => void handleTaskInvoke(py, init.body, raw))
      // The host sends nothing else; anything else is dropped.
      .otherwise(() => {});
  });
  port.postMessage({ type: "ready" });
}

async function probe(init: Extract<ChildInit, { mode: "probe" }>): Promise<void> {
  const py = await bootPyodide({
    pyodideDistDir: init.pyodideDistDir,
    packageCacheDir: init.packageCacheDir,
  });
  const failures: { name: string; reason: string }[] = [];
  // One at a time, so each failure names its package.
  for (const name of init.names) {
    const reason = await probeOne(py, name);
    if (reason !== null) failures.push({ name, reason });
  }
  port.postMessage({ type: "probed", failures });
}

async function probeOne(py: PyodideInterface, name: string): Promise<string | null> {
  const entry = py.lockfile.packages[normalizeName(name)];
  if (entry === undefined) return "not a Pyodide built-in";
  const loaded = await loadPackages(py, [name]);
  if (loaded !== null) return loaded;
  for (const module of entry.imports) {
    try {
      py.pyimport(module);
    } catch (e) {
      return `import ${module}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return null;
}

shimProcessBinding();
const parsedInit = ChildInitSchema.safeParse(data.init);
const started = parsedInit.success
  ? match(parsedInit.data).with({ mode: "run" }, run).with({ mode: "probe" }, probe).exhaustive()
  : Promise.reject(new Error(`malformed init: ${parsedInit.error.message}`));
started.catch((e: unknown) => {
  port.postMessage({ type: "fatal", error: e instanceof Error ? e.message : String(e) });
});
