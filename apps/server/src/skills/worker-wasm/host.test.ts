import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { afterAll, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { expectDefined } from "../../test/assertions.js";
import type { CtxHandler } from "../dispatcher.js";
import { loadBundledPackages } from "../pyodide-compat.js";
import {
  createWasmProbe,
  forkRunChild,
  pyodideDistDir,
  type RunOnWorkerParams,
  type RunOnWorkerResult,
  runOnWorker,
} from "./host.js";
import { type ChildGroupRecord, ChildGroupRecordSchema } from "./process-groups.js";
import { fillBuiltinCache } from "./wheel-cache.js";

/**
 * `runOnWorker` end to end: real wasm children under the boundary's flags,
 * each booting Pyodide (~1 s). The child bundle is built once for the file, on
 * the first spawn. `beforeAll` fills a package cache from Pyodide's CDN and
 * downloads one wheel from PyPI, the only steps that need the network; every
 * child loads from local files.
 */

let cacheDir: string;
let childrenDir: string;
let server: Server;
let serverUrl: string;
/** typing-extensions 4.14.0, older than the 4.15.0 pydantic's bundle carries. */
let typingExtensionsWheel: { fileName: string; bytes: Uint8Array };

const probe = createWasmProbe({
  pyodideDistDir: pyodideDistDir(),
  childrenDir: join(tmpdir(), "cogmo-wasm-children-probe"),
});

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "cogmo-wasm-cache-"));
  childrenDir = await mkdtemp(join(tmpdir(), "cogmo-wasm-children-"));
  const bundled = (await loadBundledPackages())._unsafeUnwrap();
  const filled = await fillBuiltinCache(
    { fetchImpl: fetch, bundled },
    { names: ["pydantic"], packageCacheDir: cacheDir },
  );
  assert(filled.isOk(), filled.isErr() ? JSON.stringify(filled.error) : "");
  typingExtensionsWheel = await downloadWheel("typing-extensions", "4.14.0");
  server = createServer((_req, res) => res.end("reached"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(typeof address === "object" && address !== null);
  serverUrl = `http://127.0.0.1:${address.port}/`;
}, 120_000);

/** The pure-Python wheel PyPI serves for `name==version`. */
async function downloadWheel(
  name: string,
  version: string,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const meta = z
    .object({ urls: z.array(z.object({ url: z.string() })) })
    .parse(await (await fetch(`https://pypi.org/pypi/${name}/${version}/json`)).json());
  const url = expectDefined(
    meta.urls.map((u) => u.url).find((u) => u.endsWith("-py3-none-any.whl")),
    `the ${name} ${version} wheel`,
  );
  return {
    fileName: expectDefined(url.split("/").at(-1), "the wheel's file name"),
    bytes: new Uint8Array(await (await fetch(url)).arrayBuffer()),
  };
}

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(cacheDir, { recursive: true, force: true });
  await rm(childrenDir, { recursive: true, force: true });
});

/** A task's params with the boundary's: no packages, the file's cache and records, 128 MiB. */
function task(
  params: Pick<RunOnWorkerParams, "taskId" | "skillName" | "body" | "inputs" | "ctxHandler"> &
    Partial<RunOnWorkerParams>,
): RunOnWorkerParams {
  return {
    packages: { builtins: [], wheelDir: null },
    packageCacheDir: cacheDir,
    pyodideDistDir: pyodideDistDir(),
    childrenDir,
    memoryMb: 128,
    ...params,
  };
}

function noopHandler(): CtxHandler {
  return { handle: vi.fn().mockResolvedValue(ok(null)) };
}

describe("runOnWorker (Pyodide)", () => {
  it("runs a trivial echo skill end-to-end", async () => {
    const result = await runOnWorker(
      task({
        taskId: "task-1",
        skillName: "echo",
        body: `
async def run(inputs, ctx):
    return {"echo": inputs["x"] + 1}
`,
        inputs: { x: 7 },
        ctxHandler: noopHandler(),
      }),
    );

    assert(result.ok);
    expect(result.output).toEqual({ echo: 8 });
  });

  it("routes ctx.* calls back to the host handler", async () => {
    const handler: CtxHandler = {
      handle: vi.fn(async ({ method, args }) => {
        if (method === "secrets.get" && (args as { name: string }).name === "api_key") {
          return ok("sk-live-123");
        }
        if (method === "now") return ok("2026-01-01T00:00:00.000Z");
        throw new Error(`unexpected ctx call: ${method}`);
      }),
    };

    const result = await runOnWorker(
      task({
        taskId: "task-2",
        skillName: "uses-ctx",
        body: `
async def run(inputs, ctx):
    secret = await ctx.secrets.get("api_key")
    ts = await ctx.now()
    return {"len": len(secret), "ts": ts}
`,
        inputs: {},
        ctxHandler: handler,
      }),
    );

    assert(result.ok);
    expect(result.output).toEqual({ len: 11, ts: "2026-01-01T00:00:00.000Z" });
    expect(handler.handle).toHaveBeenCalledWith({
      method: "secrets.get",
      args: expect.objectContaining({ name: "api_key" }),
    });
  });

  it("raises a refused ctx call in the skill as CtxError with its kind and message", async () => {
    const handler: CtxHandler = {
      handle: vi.fn(async () =>
        err({ kind: "not_in_allowlist", message: "secret 'x' is not declared" }),
      ),
    };
    const result = await runOnWorker(
      task({
        taskId: "task-refused",
        skillName: "refused",
        body: `
async def run(inputs, ctx):
    try:
        await ctx.secrets.get("x")
    except CtxError as e:
        return {"kind": e.kind, "message": e.message, "str": str(e)}
    return {"kind": None}
`,
        inputs: {},
        ctxHandler: handler,
      }),
    );
    assert(result.ok);
    expect(result.output).toEqual({
      kind: "not_in_allowlist",
      message: "secret 'x' is not declared",
      str: "not_in_allowlist: secret 'x' is not declared",
    });
  });

  it("fails the task naming the CtxError a skill leaves uncaught", async () => {
    const handler: CtxHandler = {
      handle: vi.fn(async () => err({ kind: "missing_effect", message: "needs reads_memory" })),
    };
    const result = await runOnWorker(
      task({
        taskId: "task-uncaught",
        skillName: "uncaught",
        body: `
async def run(inputs, ctx):
    return await ctx.memory.recall("q")
`,
        inputs: {},
        ctxHandler: handler,
      }),
    );
    assert(!result.ok);
    expect(result.error).toContain("CtxError: missing_effect: needs reads_memory");
  });

  it("hands a served null to the skill as None", async () => {
    const result = await runOnWorker(
      task({
        taskId: "task-null",
        skillName: "null-value",
        body: `
async def run(inputs, ctx):
    v = await ctx.memory.remember("fact")
    return {"isNone": v is None}
`,
        inputs: {},
        ctxHandler: noopHandler(),
      }),
    );
    assert(result.ok);
    expect(result.output).toEqual({ isNone: true });
  });

  it("returns ok: false with the Python exception when the skill raises", async () => {
    const result = await runOnWorker(
      task({
        taskId: "task-3",
        skillName: "boom",
        body: `
async def run(inputs, ctx):
    raise ValueError("kaboom")
`,
        inputs: {},
        ctxHandler: noopHandler(),
      }),
    );

    assert(!result.ok);
    expect(result.error).toContain("kaboom");
  });

  it("runs a skill that prints to stdout and stderr, which reach nothing", async () => {
    const result = await runOnWorker(
      task({
        taskId: "task-print",
        skillName: "print",
        body: `
import sys

async def run(inputs, ctx):
    for i in range(100):
        print("out", i)
        print("err", i, file=sys.stderr)
    return "printed"
`,
        inputs: {},
        ctxHandler: noopHandler(),
      }),
    );
    expect(result).toEqual({ ok: true, output: "printed" });
  });

  it("returns a plain string output", async () => {
    const result = await runOnWorker(
      task({
        taskId: "task-5",
        skillName: "string-out",
        body: `
async def run(inputs, ctx):
    return "hello"
`,
        inputs: {},
        ctxHandler: noopHandler(),
      }),
    );
    assert(result.ok);
    expect(result.output).toBe("hello");
  });

  it("returns an int output", async () => {
    const result = await runOnWorker(
      task({
        taskId: "task-6",
        skillName: "int-out",
        body: `
async def run(inputs, ctx):
    return 42
`,
        inputs: {},
        ctxHandler: noopHandler(),
      }),
    );
    assert(result.ok);
    expect(result.output).toBe(42);
  });

  it("returns a list output", async () => {
    const result = await runOnWorker(
      task({
        taskId: "task-7",
        skillName: "list-out",
        body: `
async def run(inputs, ctx):
    return [1, 2, 3]
`,
        inputs: {},
        ctxHandler: noopHandler(),
      }),
    );
    assert(result.ok);
    expect(result.output).toEqual([1, 2, 3]);
  });

  it("returns null when the skill returns None", async () => {
    const result = await runOnWorker(
      task({
        taskId: "task-8",
        skillName: "none-out",
        body: `
async def run(inputs, ctx):
    return None
`,
        inputs: {},
        ctxHandler: noopHandler(),
      }),
    );
    assert(result.ok);
    expect(result.output).toBeNull();
  });

  it("invalid Python syntax surfaces as ok:false with non-empty error", async () => {
    const result = await runOnWorker(
      task({
        taskId: "task-9",
        skillName: "syntax-error",
        body: `
async def run(inputs, ctx):
    this is not valid python
`,
        inputs: {},
        ctxHandler: noopHandler(),
      }),
    );
    assert(!result.ok);
    expect(typeof result.error).toBe("string");
    expect(result.error?.length ?? 0).toBeGreaterThan(0);
  });

  it("captures a custom Python exception class name", async () => {
    const result = await runOnWorker(
      task({
        taskId: "task-10",
        skillName: "custom-exception",
        body: `
class MyCustomError(Exception):
    pass

async def run(inputs, ctx):
    raise MyCustomError("specific failure")
`,
        inputs: {},
        ctxHandler: noopHandler(),
      }),
    );
    assert(!result.ok);
    expect(result.error).toContain("MyCustomError");
    expect(result.error).toContain("specific failure");
  });

  it("ctx.user round-trips the user dict", async () => {
    const handler: CtxHandler = {
      handle: vi.fn(async ({ method }) => {
        if (method === "user") return ok({ id: "u1", timezone: "Europe/London" });
        throw new Error(`unexpected ${method}`);
      }),
    };
    const result = await runOnWorker(
      task({
        taskId: "task-11",
        skillName: "user-test",
        body: `
async def run(inputs, ctx):
    u = await ctx.user()
    return {"got": u["id"], "tz": u["timezone"]}
`,
        inputs: {},
        ctxHandler: handler,
      }),
    );
    assert(result.ok);
    expect(result.output).toEqual({ got: "u1", tz: "Europe/London" });
  });

  it("subprocess.run() surfaces a runtime error in Pyodide", async () => {
    // Pyodide ships the stdlib (including `subprocess`), so `import subprocess`
    // succeeds — the wasm-lint pass exists precisely because the import
    // doesn't fail on its own. Calling `subprocess.run()` *does* fail
    // because there's no /bin/sh. This pins the runtime semantics so the
    // lint's purpose stays clear.
    const result = await runOnWorker(
      task({
        taskId: "task-12",
        skillName: "subprocess-run",
        body: `
import subprocess

async def run(inputs, ctx):
    subprocess.run(["echo", "hi"])
    return None
`,
        inputs: {},
        ctxHandler: noopHandler(),
      }),
    );
    assert(!result.ok);
    expect(typeof result.error).toBe("string");
    expect(result.error?.length ?? 0).toBeGreaterThan(0);
  });

  it("two sequential runOnWorker calls are independent (no shared state)", async () => {
    const handler1: CtxHandler = { handle: vi.fn(async () => ok("first")) };
    const handler2: CtxHandler = { handle: vi.fn(async () => ok("second")) };

    const body = `
async def run(inputs, ctx):
    v = await ctx.now()
    return {"v": v}
`;
    const r1 = await runOnWorker(
      task({
        taskId: "seq-1",
        skillName: "seq",
        body,
        inputs: {},
        ctxHandler: handler1,
      }),
    );
    const r2 = await runOnWorker(
      task({
        taskId: "seq-2",
        skillName: "seq",
        body,
        inputs: {},
        ctxHandler: handler2,
      }),
    );

    assert(r1.ok);
    assert(r2.ok);
    expect(r1.output).toEqual({ v: "first" });
    expect(r2.output).toEqual({ v: "second" });
    expect(handler1.handle).toHaveBeenCalledTimes(1);
    expect(handler2.handle).toHaveBeenCalledTimes(1);
  });

  it("surfaces worker_init_timeout when the worker doesn't signal ready in time", async () => {
    // Pyodide's boot alone is ~1 s, so a 50 ms readyTimeoutMs is guaranteed
    // to trip: the child is killed mid-init and the host returns a typed
    // error instead of wedging on the unbounded ready await.
    const result = await runOnWorker(
      task({
        taskId: "init-timeout",
        skillName: "init-timeout",
        body: "async def run(inputs, ctx):\n    return None\n",
        inputs: {},
        readyTimeoutMs: 50,
        ctxHandler: noopHandler(),
      }),
    );
    assert(!result.ok);
    expect(result.error).toMatch(/worker_init_timeout/);
  });

  it("nested types in inputs round-trip correctly", async () => {
    const result = await runOnWorker(
      task({
        taskId: "nested",
        skillName: "nested",
        body: `
async def run(inputs, ctx):
    nums = inputs["nums"]
    flag = inputs["flag"]
    return {"sum": sum(nums), "flag": flag}
`,
        inputs: { nums: [1, 2, 3, 4], flag: true },
        ctxHandler: noopHandler(),
      }),
    );
    assert(result.ok);
    expect(result.output).toEqual({ sum: 10, flag: true });
  });
});

function boundaryRun(
  body: string,
  overrides: Partial<RunOnWorkerParams> = {},
): Promise<RunOnWorkerResult> {
  return runOnWorker(
    task({
      taskId: "boundary",
      skillName: "boundary",
      body,
      inputs: {},
      ctxHandler: noopHandler(),
      ...overrides,
    }),
  );
}

describe("wasm boundary", () => {
  it("jsglobals: a skill cannot reach the thread's process or fetch through js", async () => {
    const result = await boundaryRun(`
async def run(inputs, ctx):
    import js
    out = {}
    for name in ["process", "fetch", "Object"]:
        out[name] = "reachable" if hasattr(js, name) else "absent"
    return out
`);
    assert(result.ok, result.ok ? "" : result.error);
    expect(result.output).toEqual({ process: "absent", fetch: "absent", Object: "absent" });
  });

  it("network: pyfetch reaches nothing, even a server on loopback", async () => {
    const result = await boundaryRun(
      `
async def run(inputs, ctx):
    from pyodide.http import pyfetch
    try:
        r = await pyfetch(inputs["url"])
        return {"reached": await r.string()}
    except Exception as e:
        return {"failed": type(e).__name__}
`,
      { inputs: { url: serverUrl } },
    );
    assert(result.ok, result.ok ? "" : result.error);
    // `pyfetch` reaches for `js.fetch`, which the restricted `jsglobals` lacks.
    expect(result.output).toEqual({ failed: "NameError" });
  });

  it("network: a socket through Node's own sockets reaches nothing, even a server on loopback", async () => {
    // Plain Node runs this body to the server; under the child's flags Node's
    // `net` throws ERR_ACCESS_DENIED, which Emscripten's socket layer reports
    // to Python as a refused connection, whatever the cause.
    let connections = 0;
    const onConnection = (): void => {
      connections += 1;
    };
    server.on("connection", onConnection);
    const result = await boundaryRun(
      `
async def run(inputs, ctx):
    import socket
    import pyodide_js
    await pyodide_js.useNodeSockFS()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.connect(("127.0.0.1", inputs["port"]))
        s.sendall(b"GET / HTTP/1.0\\r\\n\\r\\n")
        return {"reached": s.recv(100).decode()}
    except BaseException as e:
        return {"failed": f"{type(e).__name__}: {e}"}
`,
      { inputs: { port: Number(new URL(serverUrl).port) } },
    );
    server.off("connection", onConnection);
    assert(result.ok, result.ok ? "" : result.error);
    expect(result.output).toEqual({ failed: expect.stringMatching(/^ConnectionRefusedError: /) });
    expect(connections).toBe(0);
  });

  it("permission: mounting a host path outside the grant fails, while a granted one mounts", async () => {
    // A plain JS object's constructor is Object, so the mount options can be
    // built without the 'js' module; only the permission model stands in the
    // way. The granted mount is the control: the same NODEFS call on a path
    // the child may read succeeds, so the refusal is the grant's.
    const result = await boundaryRun(
      `
async def run(inputs, ctx):
    import os
    import pyodide_js
    from pyodide.ffi import to_js
    FS = pyodide_js.FS
    fromEntries = pyodide_js.lockfile.constructor.fromEntries

    def mount(root, at):
        FS.mkdir(at)
        try:
            FS.mount(FS.filesystems.NODEFS, to_js({"root": root}, dict_converter=fromEntries), at)
            return {"listed": len(os.listdir(at))}
        except Exception as e:
            return {"failed": str(e)[:200]}

    return {"granted": mount(inputs["granted"], "/granted"), "outside": mount("/etc", "/host")}
`,
      { inputs: { granted: await realpath(cacheDir) } },
    );
    assert(result.ok, result.ok ? "" : result.error);
    expect(result.output).toEqual({
      granted: { listed: (await readdir(cacheDir)).length },
      outside: { failed: expect.any(String) },
    });
  });

  it("code generation: the Function constructor behind a JS proxy throws EvalError", async () => {
    const result = await boundaryRun(`
async def run(inputs, ctx):
    import js
    try:
        return {"ran": js.setTimeout.constructor("return 1")()}
    except Exception as e:
        return {"failed": str(e)[:200]}
`);
    assert(result.ok, result.ok ? "" : result.error);
    expect(result.output).toEqual({ failed: expect.stringContaining("EvalError") });
  });

  it("env: the child process and Python see no host variable", async () => {
    // Set in this process by vitest.config.ts's UNIT_ENV.
    expect(process.env.HINDSIGHT_API_KEY).toBeDefined();
    const seen: { environ?: string } = {};
    const result = await boundaryRun(
      `
async def run(inputs, ctx):
    import os
    await ctx.now()
    return {"keys": sorted(os.environ.keys())}
`,
      {
        ctxHandler: {
          handle: vi.fn(async () => {
            const [record] = await liveRecords();
            assert(record !== undefined, "a record for the running child");
            seen.environ = await readFile(`/proc/${record.pid}/environ`, "utf8");
            return ok("now");
          }),
        },
      },
    );
    assert(result.ok, result.ok ? "" : result.error);
    const keys = expectDefined(seen.environ, "the child's environ")
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => entry.slice(0, entry.indexOf("=")));
    // fork() hands the IPC channel over through these two.
    expect(keys.filter((k) => !k.startsWith("NODE_CHANNEL_"))).toEqual([]);
    expect(result.output).toEqual({ keys: expect.not.arrayContaining(["HINDSIGHT_API_KEY"]) });
  });

  it("memory: allocating past memoryMb raises MemoryError and the interpreter survives", async () => {
    const result = await boundaryRun(`
async def run(inputs, ctx):
    try:
        b = bytearray(256 * 1024 * 1024)
        return {"allocated": len(b)}
    except MemoryError:
        return {"memoryError": True, "after": len(bytearray(1024))}
`);
    assert(result.ok, result.ok ? "" : result.error);
    expect(result.output).toEqual({ memoryError: true, after: 1024 });
  });

  it("cpu: a tight loop ends as wall_clock_exceeded", { timeout: 15_000 }, async () => {
    const result = await boundaryRun(
      "async def run(inputs, ctx):\n    while True:\n        pass\n",
      {
        wallClockS: 1,
      },
    );
    expect(result).toEqual({ ok: false, error: "wall_clock_exceeded" });
  });

  it("cpu: a result after the interrupt is wall_clock_exceeded, even one that caught it", {
    timeout: 15_000,
  }, async () => {
    const result = await boundaryRun(
      `
async def run(inputs, ctx):
    try:
        while True:
            pass
    except KeyboardInterrupt:
        return {"ok": True}
`,
      { wallClockS: 1 },
    );
    expect(result).toEqual({ ok: false, error: "wall_clock_exceeded" });
  });

  it("records the child's process group while it runs, and deletes the record after", async () => {
    let during: readonly ChildGroupRecord[] = [];
    const result = await boundaryRun("async def run(inputs, ctx):\n    return await ctx.now()\n", {
      ctxHandler: {
        handle: vi.fn(async () => {
          during = await liveRecords();
          return ok("now");
        }),
      },
    });
    assert(result.ok, result.ok ? "" : result.error);
    expect(during).toHaveLength(1);
    const record = expectDefined(during[0], "the record");
    expect(record.bootId).toBe((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
    expect(record.pid).not.toBe(process.pid);
    expect(await liveRecords()).toEqual([]);
    expect(() => process.kill(record.pid, 0)).toThrow();
  });

  it("the child exits when its host's IPC channel closes", async () => {
    const forked = await forkRunChild(
      task({
        taskId: "orphan",
        skillName: "orphan",
        body: "async def run(inputs, ctx):\n    return None\n",
        inputs: {},
        ctxHandler: noopHandler(),
      }),
    );
    assert(forked.isOk(), forked.isErr() ? forked.error : "");
    const child = forked.value;
    expect(await liveRecords()).toHaveLength(1);
    child.ipc.disconnect();
    await child.exited;
    expect(await liveRecords()).toEqual([]);
  });

  it("loads built-ins from the filled cache, with no network", async () => {
    const result = await boundaryRun(
      `
import pydantic

class Point(pydantic.BaseModel):
    x: int

async def run(inputs, ctx):
    return {"x": Point(x="3").x, "version": pydantic.VERSION}
`,
      { packages: { builtins: ["pydantic"], wheelDir: null } },
    );
    assert(result.ok, result.ok ? "" : result.error);
    expect(result.output).toEqual({ x: 3, version: expect.any(String) });
  });

  it("fails the boot when a built-in is missing from the cache, rather than fetch it", async () => {
    const result = await boundaryRun("async def run(inputs, ctx):\n    return None\n", {
      packages: { builtins: ["numpy"], wheelDir: null },
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/^worker init failed: .*numpy/),
    });
  });

  it("installs the wheel directory's wheels without the network", async () => {
    const wheelDir = await mkdtemp(join(tmpdir(), "cogmo-wasm-wheels-"));
    try {
      const wheel = expectDefined(
        (await readdir(cacheDir)).find((f) => f.startsWith("annotated_types-")),
        "the annotated_types wheel in the cache",
      );
      await copyFile(join(cacheDir, wheel), join(wheelDir, wheel));
      const result = await boundaryRun(
        `
import importlib.metadata
import annotated_types

async def run(inputs, ctx):
    return importlib.metadata.version("annotated_types")
`,
        { packages: { builtins: [], wheelDir } },
      );
      assert(result.ok, result.ok ? "" : result.error);
      expect(result.output).toBe(wheel.split("-")[1]);
    } finally {
      await rm(wheelDir, { recursive: true, force: true });
    }
  });
});

describe("forking a run child", () => {
  it("grants and hands the child resolved paths when the cache and wheel directory are symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "cogmo-wasm-links-"));
    try {
      const wheelDir = join(root, "wheels");
      await mkdir(wheelDir);
      const wheel = expectDefined(
        (await readdir(cacheDir)).find((f) => f.startsWith("annotated_types-")),
        "the annotated_types wheel in the cache",
      );
      await copyFile(join(cacheDir, wheel), join(wheelDir, wheel));
      await symlink(wheelDir, join(root, "wheels-link"));
      await symlink(cacheDir, join(root, "cache-link"));
      const result = await boundaryRun(
        `
import importlib.metadata
import annotated_types
import pydantic

async def run(inputs, ctx):
    return importlib.metadata.version("annotated_types")
`,
        {
          packageCacheDir: join(root, "cache-link"),
          packages: { builtins: ["pydantic"], wheelDir: join(root, "wheels-link") },
        },
      );
      assert(result.ok, result.ok ? "" : result.error);
      expect(result.output).toBe(wheel.split("-")[1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Root writes into the read-only directory this test relies on refusing it.
  it.skipIf(process.getuid?.() === 0)(
    "kills the child and fails the run when its record cannot be written",
    async () => {
      const readOnly = await mkdtemp(join(tmpdir(), "cogmo-wasm-children-ro-"));
      await chmod(readOnly, 0o555);
      try {
        const result = await boundaryRun("async def run(inputs, ctx):\n    return None\n", {
          childrenDir: readOnly,
        });
        assert(!result.ok);
        const recorded = /^worker init failed: could not record child (\d+): /.exec(result.error);
        const pid = Number(expectDefined(recorded?.[1], `the child's pid in ${result.error}`));
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        expect(await readdir(readOnly)).toEqual([]);
      } finally {
        await chmod(readOnly, 0o755);
        await rm(readOnly, { recursive: true, force: true });
      }
    },
  );

  it("fails the task, not the child, on an output JSON cannot carry", async () => {
    const result = await boundaryRun('async def run(inputs, ctx):\n    return {"n": 2**60}\n');
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/^task output is not JSON-serializable: .*BigInt/),
    });
  });

  it("fails the task, not the child, on an output structured clone cannot carry", async () => {
    const result = await boundaryRun('async def run(inputs, ctx):\n    return {"f": lambda: 1}\n');
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/^task output is not serializable: .*could not be cloned/),
    });
  });

  it("fails the ctx call, not the child, on arguments JSON cannot carry", async () => {
    const handler = noopHandler();
    const result = await boundaryRun(
      `
async def run(inputs, ctx):
    try:
        await ctx.http.get("https://example.com", headers={"n": 2**60})
    except Exception as e:
        return {"failed": str(e)}
`,
      { ctxHandler: handler },
    );
    assert(result.ok, result.ok ? "" : result.error);
    expect(result.output).toEqual({
      failed: expect.stringMatching(/^invalid_args: ctx call arguments are not JSON-serializable/),
    });
    expect(handler.handle).not.toHaveBeenCalled();
  });
});

describe("createWasmProbe", () => {
  it("probes built-ins that load under the boundary's flags", async () => {
    const probed = await probe.probeBuiltins(["pydantic"], { packageCacheDir: cacheDir });
    expect(probed.isOk()).toBe(true);
  });

  it("reports each built-in that fails to load", async () => {
    const probed = await probe.probeBuiltins(["pydantic", "numpy", "not-a-package"], {
      packageCacheDir: cacheDir,
    });
    assert(probed.isErr());
    assert(probed.error.kind === "rejected");
    expect(probed.error.failures.map((f) => f.name)).toEqual(["numpy", "not-a-package"]);
  });
});

/** The records under the file's children directory. */
async function liveRecords(): Promise<ChildGroupRecord[]> {
  const files = (await readdir(childrenDir)).filter((f) => f.endsWith(".json"));
  return Promise.all(
    files.map(async (f) =>
      ChildGroupRecordSchema.parse(JSON.parse(await readFile(join(childrenDir, f), "utf8"))),
    ),
  );
}

describe("wheels and built-ins together", () => {
  it("keeps a lockfile's pin of a built-in's bundled dependency", async () => {
    // pydantic's bundled typing-extensions is 4.15.0; the lockfile pins 4.14.0.
    const wheelDir = await mkdtemp(join(tmpdir(), "cogmo-wasm-wheels-"));
    try {
      await writeFile(join(wheelDir, typingExtensionsWheel.fileName), typingExtensionsWheel.bytes);
      const result = await boundaryRun(
        `
import importlib.metadata
import pydantic

async def run(inputs, ctx):
    return importlib.metadata.version("typing_extensions")
`,
        { packages: { builtins: ["pydantic"], wheelDir } },
      );
      assert(result.ok, result.ok ? "" : result.error);
      expect(result.output).toBe("4.14.0");
    } finally {
      await rm(wheelDir, { recursive: true, force: true });
    }
  });
});
