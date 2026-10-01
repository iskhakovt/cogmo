import type { MessagePort } from "node:worker_threads";
import { parentPort, workerData } from "node:worker_threads";
import { loadPyodide, type PyodideInterface } from "pyodide";
import { CtxResultSchema, TaskInvokeSchema, type TaskResult } from "../protocol.js";
import { CTX_PY } from "./ctx.py.js";

interface WorkerInit {
  port: MessagePort;
  body: string;
  packageCacheDir?: string;
  /**
   * Direct `pkg==version` specs to `micropip.install` before signalling
   * ready. Sourced from the skill's `requirements.lock` parsed
   * host-side; absent/empty means stdlib + Pyodide built-ins only.
   */
  packageSpecs?: string[];
  interruptBuffer?: SharedArrayBuffer;
}

const init = workerData as WorkerInit;
const port: MessagePort = init.port;

if (!parentPort) {
  throw new Error("worker-entry must run inside a worker thread");
}

/**
 * A ctx call's answer as it reaches Python. `Ctx._call` in ctx.py returns
 * the value or raises `CtxError(kind, message)`, the class tier 2 raises: a
 * plain value crosses into Pyodide intact, where a rejected promise arrives
 * as a `JsException` carrying only the error's name and message.
 */
type BridgeReply = { ok: true; value: unknown } | { ok: false; kind: string; message: string };

// ctx_call → ctx_result correlation. The Python `ctx` proxy awaits these
// JS Promises, settled when the matching ctx_result arrives.
const pendingCtxCalls = new Map<
  string,
  { resolve: (reply: BridgeReply) => void; reject: (e: Error) => void }
>();
let nextCtxId = 0;

/**
 * Bridge object exposed to Python via `pyodide.registerJsModule`. Every call
 * names `taskId`: the host serves a ctx call only for the task it belongs to.
 */
function bridgeFor(taskId: string): {
  call(method: string, args: unknown): Promise<BridgeReply>;
} {
  return { call: (method, args) => callHost(taskId, method, args) };
}

function callHost(taskId: string, method: string, args: unknown): Promise<BridgeReply> {
  const id = `ctx-${nextCtxId++}`;
  return new Promise((resolve, reject) => {
    pendingCtxCalls.set(id, { resolve, reject });
    try {
      port.postMessage({ type: "ctx_call", taskId, id, method, args });
    } catch (e) {
      // Send failed (port closed, transferable detached): the channel is
      // gone, so no reply will come. Drop the pending entry and fail the
      // awaiting Python coroutine rather than leave it hung.
      pendingCtxCalls.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

let pyodide: PyodideInterface | null = null;

function handleCtxResult(raw: unknown): void {
  const parsed = CtxResultSchema.safeParse(raw);
  if (!parsed.success) return;
  const result = parsed.data;
  const pending = pendingCtxCalls.get(result.id);
  if (!pending) return;
  pendingCtxCalls.delete(result.id);
  pending.resolve(
    result.ok
      ? { ok: true, value: result.value }
      : { ok: false, kind: result.errorKind, message: result.message },
  );
}

async function runTask(invoke: { id: string; inputs: unknown }): Promise<TaskResult> {
  if (!pyodide) throw new Error("pyodide not initialized");
  const py = pyodide;

  // The bridge module gives Python access to host RPCs.
  py.registerJsModule("__cogmo_bridge__", { bridge: bridgeFor(invoke.id) });

  // Materialize ctx SDK + skill body into module-level globals. One task
  // runs per thread — the port transport's synthetic `task_exited` relies
  // on it — so module-level globals are safe.
  await py.runPythonAsync(CTX_PY);
  await py.runPythonAsync(
    "from __cogmo_bridge__ import bridge as __cogmo_bridge\n_ctx = _build_ctx(__cogmo_bridge)\n",
  );
  await py.runPythonAsync(init.body);

  // Inject inputs as a Python dict and await `run(inputs, ctx)`.
  const inputsPy = py.toPy(invoke.inputs);
  py.globals.set("__cogmo_inputs", inputsPy);
  const resultPy = await py.runPythonAsync("await run(__cogmo_inputs, _ctx)");

  // Convert PyProxy → plain JS for postMessage cloning. Plain values
  // (strings, numbers, booleans, null/undefined) come through as-is and
  // have no toJs / destroy methods. Only objects could be PyProxy instances.
  let output: unknown = resultPy ?? null;
  if (typeof resultPy === "object" && resultPy !== null) {
    const proxy = resultPy as {
      toJs?: (opts: { dict_converter: unknown }) => unknown;
      destroy?: () => void;
    };
    if (typeof proxy.toJs === "function") {
      output = proxy.toJs({ dict_converter: Object.fromEntries });
    }
    if (typeof proxy.destroy === "function") proxy.destroy();
  }
  inputsPy.destroy?.();
  // Only the top-level PyProxy is destroyed explicitly. If `run()` returned
  // a nested dict, `toJs` recursively converts but the inner PyProxies
  // aren't tracked individually — they leak until the worker thread exits.
  // Acceptable because one task runs per thread, and the thread exits after
  // it.

  return { type: "task_result", id: invoke.id, ok: true, output };
}

async function handleTaskInvoke(raw: unknown): Promise<void> {
  const parsed = TaskInvokeSchema.safeParse(raw);
  if (!parsed.success) return;
  const invoke = parsed.data;
  try {
    port.postMessage(await runTask(invoke));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const failure: TaskResult = {
      type: "task_result",
      id: invoke.id,
      ok: false,
      error: message,
    };
    port.postMessage(failure);
  }
}

port.on("message", (raw: unknown) => {
  const obj = raw as { type?: string };
  if (obj?.type === "ctx_result") {
    handleCtxResult(raw);
  } else if (obj?.type === "task_invoke") {
    void handleTaskInvoke(raw);
  }
});

(async () => {
  pyodide = await loadPyodide({
    ...(init.packageCacheDir && { packageCacheDir: init.packageCacheDir }),
  });
  if (init.interruptBuffer) {
    pyodide.setInterruptBuffer(new Uint8Array(init.interruptBuffer));
  }

  // No `--require-hashes` equivalent in micropip; WASM-tier trusts
  // PyPI wire integrity. See `design/skills.md` → Security posture.
  // Pyodide-incompatible deps surface as a `fatal` init error here
  // because register-time pre-check against `pyodide-lock.json` is
  // deferred (todo.md). Post-install version verification catches
  // silent resolver skips and any bundled-vs-pin drift.
  if (init.packageSpecs && init.packageSpecs.length > 0) {
    await pyodide.loadPackage("micropip");
    pyodide.globals.set("__cogmo_skill_deps", init.packageSpecs);
    await pyodide.runPythonAsync(`
import micropip
import importlib.metadata as _md

async def _install_and_verify(specs):
    await micropip.install(specs, keep_going=False)
    mismatches = []
    for spec in specs:
        name, _, version = spec.partition("==")
        if not version:
            continue
        try:
            installed = _md.version(name)
        except _md.PackageNotFoundError:
            mismatches.append(f"{name}: not installed")
            continue
        if installed != version:
            mismatches.append(f"{name}: requested {version}, installed {installed}")
    if mismatches:
        raise RuntimeError("dep version verification failed: " + "; ".join(mismatches))

await _install_and_verify(list(__cogmo_skill_deps))
del __cogmo_skill_deps
`);
  }

  // Tell the host the worker is ready to receive task_invoke.
  port.postMessage({ type: "ready" });
})().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  port.postMessage({ type: "fatal", error: message });
});
