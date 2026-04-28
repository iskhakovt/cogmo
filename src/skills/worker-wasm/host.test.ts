import { afterAll, describe, expect, it, vi } from "vitest";
import type { CtxHandler } from "../dispatcher.js";
import { runOnWorker } from "./host.js";

/**
 * End-to-end Pyodide tests. `loadPyodide()` is ~5s cold; this whole file
 * pays it once via Vitest's per-file isolation. Each test spawns a fresh
 * worker because the slice-3 host implementation is one-shot per call.
 *
 * Tagged with a longer testTimeout because of the cold-start cost.
 */

afterAll(() => {
  // Vitest's process exit hook is sometimes racy when a worker thread is
  // still spinning down. The host's `worker.terminate()` covers cleanup; this
  // is a safety reset for the spy hooks below.
  vi.restoreAllMocks();
});

function noopHandler(): CtxHandler {
  return { handle: vi.fn().mockResolvedValue(null) };
}

describe("runOnWorker (Pyodide)", { timeout: 60_000 }, () => {
  it("runs a trivial echo skill end-to-end", async () => {
    const result = await runOnWorker({
      taskId: "task-1",
      skillName: "echo",
      body: `
async def run(inputs, ctx):
    return {"echo": inputs["x"] + 1}
`,
      inputs: { x: 7 },
      ctxHandler: noopHandler(),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ echo: 8 });
  });

  it("routes ctx.* calls back to the host handler", async () => {
    const handler: CtxHandler = {
      handle: vi.fn(async ({ method, args }) => {
        if (method === "secrets.get" && (args as { name: string }).name === "api_key") {
          return "sk-live-123";
        }
        if (method === "now") return "2026-01-01T00:00:00.000Z";
        throw new Error(`unexpected ctx call: ${method}`);
      }),
    };

    const result = await runOnWorker({
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
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ len: 11, ts: "2026-01-01T00:00:00.000Z" });
    expect(handler.handle).toHaveBeenCalledWith({
      method: "secrets.get",
      args: expect.objectContaining({ name: "api_key" }),
    });
  });

  it("returns ok: false with the Python exception when the skill raises", async () => {
    const result = await runOnWorker({
      taskId: "task-3",
      skillName: "boom",
      body: `
async def run(inputs, ctx):
    raise ValueError("kaboom")
`,
      inputs: {},
      ctxHandler: noopHandler(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("kaboom");
  });

  it("enforces wall-clock cap and falls back to worker.terminate on tight loops", {
    timeout: 15_000,
  }, async () => {
    const result = await runOnWorker({
      taskId: "task-4",
      skillName: "loop",
      body: `
async def run(inputs, ctx):
    n = 0
    while True:
        n += 1
`,
      inputs: {},
      wallClockS: 1,
      ctxHandler: noopHandler(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("wall_clock_exceeded");
  });

  it("returns a plain string output", async () => {
    const result = await runOnWorker({
      taskId: "task-5",
      skillName: "string-out",
      body: `
async def run(inputs, ctx):
    return "hello"
`,
      inputs: {},
      ctxHandler: noopHandler(),
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello");
  });

  it("returns an int output", async () => {
    const result = await runOnWorker({
      taskId: "task-6",
      skillName: "int-out",
      body: `
async def run(inputs, ctx):
    return 42
`,
      inputs: {},
      ctxHandler: noopHandler(),
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe(42);
  });

  it("returns a list output", async () => {
    const result = await runOnWorker({
      taskId: "task-7",
      skillName: "list-out",
      body: `
async def run(inputs, ctx):
    return [1, 2, 3]
`,
      inputs: {},
      ctxHandler: noopHandler(),
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual([1, 2, 3]);
  });

  it("returns null when the skill returns None", async () => {
    const result = await runOnWorker({
      taskId: "task-8",
      skillName: "none-out",
      body: `
async def run(inputs, ctx):
    return None
`,
      inputs: {},
      ctxHandler: noopHandler(),
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBeNull();
  });

  it("invalid Python syntax surfaces as ok:false with non-empty error", async () => {
    const result = await runOnWorker({
      taskId: "task-9",
      skillName: "syntax-error",
      body: `
async def run(inputs, ctx):
    this is not valid python
`,
      inputs: {},
      ctxHandler: noopHandler(),
    });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error?.length ?? 0).toBeGreaterThan(0);
  });

  it("captures a custom Python exception class name", async () => {
    const result = await runOnWorker({
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
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("MyCustomError");
    expect(result.error).toContain("specific failure");
  });

  it("ctx.user round-trips the user dict", async () => {
    const handler: CtxHandler = {
      handle: vi.fn(async ({ method }) => {
        if (method === "user") return { id: "u1", timezone: "Europe/London" };
        throw new Error(`unexpected ${method}`);
      }),
    };
    const result = await runOnWorker({
      taskId: "task-11",
      skillName: "user-test",
      body: `
async def run(inputs, ctx):
    u = await ctx.user()
    return {"got": u["id"], "tz": u["timezone"]}
`,
      inputs: {},
      ctxHandler: handler,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ got: "u1", tz: "Europe/London" });
  });

  it("subprocess.run() surfaces a runtime error in Pyodide", async () => {
    // Pyodide ships the stdlib (including `subprocess`), so `import subprocess`
    // succeeds — the wasm-lint pass exists precisely because the import
    // doesn't fail on its own. Calling `subprocess.run()` *does* fail
    // because there's no /bin/sh. This pins the runtime semantics so the
    // lint's purpose stays clear.
    const result = await runOnWorker({
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
    });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error?.length ?? 0).toBeGreaterThan(0);
  });

  it("two sequential runOnWorker calls are independent (no shared state)", async () => {
    const handler1: CtxHandler = { handle: vi.fn(async () => "first") };
    const handler2: CtxHandler = { handle: vi.fn(async () => "second") };

    const body = `
async def run(inputs, ctx):
    v = await ctx.now()
    return {"v": v}
`;
    const r1 = await runOnWorker({
      taskId: "seq-1",
      skillName: "seq",
      body,
      inputs: {},
      ctxHandler: handler1,
    });
    const r2 = await runOnWorker({
      taskId: "seq-2",
      skillName: "seq",
      body,
      inputs: {},
      ctxHandler: handler2,
    });

    expect(r1.output).toEqual({ v: "first" });
    expect(r2.output).toEqual({ v: "second" });
    expect(handler1.handle).toHaveBeenCalledTimes(1);
    expect(handler2.handle).toHaveBeenCalledTimes(1);
  });

  it("nested types in inputs round-trip correctly", async () => {
    const result = await runOnWorker({
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
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ sum: 10, flag: true });
  });
});
