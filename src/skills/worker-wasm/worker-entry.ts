import type { MessagePort } from "node:worker_threads";
import { parentPort, workerData } from "node:worker_threads";
import { loadPyodide, type PyodideInterface } from "pyodide";
import { CtxResultSchema, TaskInvokeSchema, type TaskResult } from "../protocol.js";
import { CTX_PY } from "./ctx.py.js";

interface WorkerInit {
  port: MessagePort;
  body: string;
  packageCacheDir?: string;
  interruptBuffer?: SharedArrayBuffer;
}

const init = workerData as WorkerInit;
const port: MessagePort = init.port;

if (!parentPort) {
  throw new Error("worker-entry must run inside a worker thread");
}

// ctx_call → ctx_result correlation. The Python `ctx` proxy resolves these
// JS Promises when the matching ctx_result arrives.
const pendingCtxCalls = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (e: HostCtxError) => void }
>();
let nextCtxId = 0;

class HostCtxError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    // Pyodide surfaces JS errors to Python as `pyodide.ffi.JsException`,
    // which carries `name` and `message` but no arbitrary attributes — so
    // the kind disappears unless we encode it in the message itself. The
    // `kind=...` prefix is parsed by ctx.py to materialize a typed Python
    // exception.
    super(`kind=${kind}: ${message}`);
    this.kind = kind;
    this.name = `CtxError(${kind})`;
  }
}

/** Bridge object exposed to Python via `pyodide.registerJsModule`. */
const bridge = {
  call(method: string, args: unknown): Promise<unknown> {
    const id = `ctx-${nextCtxId++}`;
    return new Promise((resolve, reject) => {
      pendingCtxCalls.set(id, { resolve, reject });
      port.postMessage({ type: "ctx_call", id, method, args });
    });
  },
};

let pyodide: PyodideInterface | null = null;

function handleCtxResult(raw: unknown): void {
  const parsed = CtxResultSchema.safeParse(raw);
  if (!parsed.success) return;
  const result = parsed.data;
  const pending = pendingCtxCalls.get(result.id);
  if (!pending) return;
  pendingCtxCalls.delete(result.id);
  if (result.ok) {
    pending.resolve(result.value);
  } else {
    pending.reject(new HostCtxError(result.errorKind, result.message));
  }
}

async function runTask(invoke: { id: string; inputs: unknown }): Promise<TaskResult> {
  if (!pyodide) throw new Error("pyodide not initialized");
  const py = pyodide;

  // The bridge module gives Python access to host RPCs.
  py.registerJsModule("__cogmo_bridge__", { bridge });

  // Materialize ctx SDK + skill body into module-level globals. Each worker
  // is one-shot in this slice (warm pool with per-task reset lands in P3.2),
  // so module-level globals are safe.
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
  // Tell the host the worker is ready to receive task_invoke.
  port.postMessage({ type: "ready" });
})().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  port.postMessage({ type: "fatal", error: message });
});
