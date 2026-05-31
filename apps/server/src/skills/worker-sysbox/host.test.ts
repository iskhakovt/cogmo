import { PassThrough, type Readable, type Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ExecStreamingHandle,
  type LocalDockerSessionState,
  LocalDockerSessionStateSchema,
  type SandboxClient,
  type SandboxSession,
} from "../../sandbox/index.js";
import type { CtxHandler } from "../dispatcher.js";
import { runOnSysboxContainer } from "./host.js";

/**
 * `runOnSysboxContainer` is the resource-override one-shot path — used by
 * skills that declare `resources.{cpu_shares,memory_mb}` and bypass the
 * warm pool. Internally it builds a `SysboxSkillWorker`, acquires it,
 * invokes the task, and disposes. The lifecycle (create → invoke →
 * dispose, including dispose-on-error) is what these tests pin.
 */

interface FakeSandboxBundle {
  sandbox: SandboxClient<LocalDockerSessionState>;
  /** stdin we hand to the worker; tests push mock task_result lines into stdout. */
  stdin: PassThrough;
  stdout: PassThrough;
  /** call sites in execution order — useful for asserting the worker's lifecycle. */
  calls: string[];
}

function buildFakeSandbox(): FakeSandboxBundle {
  const calls: string[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const exec: ExecStreamingHandle = {
    stdin: stdin as unknown as Writable,
    stdout: stdout as unknown as Readable,
    stderr: stderr as unknown as Readable,
    wait: async () => ({ exitCode: 0 }),
    dispose: async () => {
      calls.push("exec.dispose");
    },
  };

  const session: SandboxSession<LocalDockerSessionState> = {
    state: {
      type: "local-docker",
      taskId: "host-fake",
      containerRowId: "row-1",
      dockerId: "docker-fake",
    },
    exec: vi.fn(),
    execStreaming: vi.fn(async (cmd) => {
      calls.push(`exec:${cmd[0]}:${cmd[1]}`);
      return exec;
    }),
  };

  const sandbox: SandboxClient<LocalDockerSessionState> = {
    backendId: "fake",
    capabilities: {
      siblingContainers: "host-proxy",
      hostBindMount: true,
      customImage: true,
      volumes: "docker",
      workingTreeTransport: "bind-mount",
      depsCacheSharing: "shared-volume",
    },
    healthCheck: vi.fn(),
    reconcileCrashedInstances: vi.fn(),
    ensureImagePresent: vi.fn(async (image: string) => {
      calls.push(`ensureImage:${image}`);
    }),
    create: vi.fn(async (spec) => {
      calls.push(`create:${spec.taskId}:${spec.image}`);
      return session;
    }),
    resume: vi.fn(async () => session),
    tryResumeByTaskId: vi.fn(async () => null),
    delete: vi.fn(async (s) => {
      calls.push(`delete:${s.state.taskId}`);
    }),
    deleteByTaskId: vi.fn(async () => {}),
    serializeState: (s) => LocalDockerSessionStateSchema.parse(s),
    deserializeState: (p) => LocalDockerSessionStateSchema.parse(p),
    shutdown: vi.fn(),
  };

  return { sandbox, stdin, stdout, calls };
}

const noopCtx: CtxHandler = { handle: async () => null };

/** Auto-respond to any `task_invoke` line by echoing a matching `task_result`. */
function autoRespond(
  bundle: FakeSandboxBundle,
  result: { ok: boolean; output?: unknown; error?: string },
): void {
  bundle.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk
      .toString()
      .split("\n")
      .filter((l) => l.length > 0)) {
      try {
        const msg = JSON.parse(line) as { type?: unknown; id?: unknown };
        if (msg.type === "task_invoke" && typeof msg.id === "string") {
          bundle.stdout.write(
            `${JSON.stringify({ type: "task_result", id: msg.id, ...result })}\n`,
          );
        }
      } catch {
        // ignore non-json
      }
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runOnSysboxContainer", () => {
  it("creates worker, invokes, returns result, and disposes — happy path", async () => {
    const bundle = buildFakeSandbox();
    autoRespond(bundle, { ok: true, output: { x: 7 } });

    const result = await runOnSysboxContainer({
      taskId: "task-happy",
      skillName: "echo",
      body: "async def run(inputs, ctx):\n    return {'x': 7}\n",
      inputs: {},
      image: "python:3.14-slim",
      sandbox: bundle.sandbox,
      ctxHandler: noopCtx,
    });

    expect(result).toMatchObject({ ok: true, output: { x: 7 } });

    // Lifecycle: ensureImage → create → exec → ... → exec.dispose → delete.
    expect(bundle.calls).toContain("ensureImage:python:3.14-slim");
    expect(bundle.calls).toContain("create:task-happy:python:3.14-slim");
    expect(bundle.calls).toContain("exec:python3:-u");
    expect(bundle.calls).toContain("exec.dispose");
    expect(bundle.calls).toContain("delete:host-fake");
  });

  it("forwards resource overrides to sandbox.create", async () => {
    const bundle = buildFakeSandbox();
    autoRespond(bundle, { ok: true, output: null });

    await runOnSysboxContainer({
      taskId: "task-res",
      skillName: "heavy",
      body: "async def run(inputs, ctx):\n    return None\n",
      inputs: {},
      image: "python:3.14-slim",
      sandbox: bundle.sandbox,
      ctxHandler: noopCtx,
      resourceLimits: { memory_bytes: 2 * 1024 * 1024 * 1024 },
    });

    expect(bundle.sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceLimits: expect.objectContaining({
          memory_bytes: 2 * 1024 * 1024 * 1024,
        }),
      }),
    );
  });

  it("forwards isolation declaration on the task_invoke", async () => {
    const bundle = buildFakeSandbox();
    autoRespond(bundle, { ok: true, output: null });

    const sentLines: string[] = [];
    bundle.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk
        .toString()
        .split("\n")
        .filter((l) => l.length > 0)) {
        sentLines.push(line);
      }
    });

    await runOnSysboxContainer({
      taskId: "task-iso",
      skillName: "iso",
      body: "async def run(inputs, ctx):\n    return None\n",
      inputs: {},
      image: "python:3.14-slim",
      sandbox: bundle.sandbox,
      ctxHandler: noopCtx,
      isolation: "recycle",
    });

    const taskInvoke = sentLines
      .map((l) => JSON.parse(l) as { type?: string; isolation?: string })
      .find((m) => m.type === "task_invoke");
    expect(taskInvoke?.isolation).toBe("recycle");
  });

  it("computes expiresAt from wallClockS + reaper backstop", async () => {
    const bundle = buildFakeSandbox();
    autoRespond(bundle, { ok: true, output: null });
    const before = Date.now();

    await runOnSysboxContainer({
      taskId: "task-ttl",
      skillName: "any",
      body: "async def run(inputs, ctx):\n    return None\n",
      inputs: {},
      image: "python:3.14-slim",
      sandbox: bundle.sandbox,
      ctxHandler: noopCtx,
      wallClockS: 10,
    });

    expect(bundle.sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: expect.any(Date),
      }),
    );
    const expiresAt = (bundle.sandbox.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      .expiresAt as Date;
    // wallClockS=10 + REAPER_BACKSTOP_S=30 = 40s from "before".
    const ttlMs = expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(40_000);
    expect(ttlMs).toBeLessThan(45_000);
  });

  it("falls back to default 60s wall-clock for expiresAt when none declared", async () => {
    const bundle = buildFakeSandbox();
    autoRespond(bundle, { ok: true, output: null });
    const before = Date.now();

    await runOnSysboxContainer({
      taskId: "task-default-ttl",
      skillName: "any",
      body: "async def run(inputs, ctx):\n    return None\n",
      inputs: {},
      image: "python:3.14-slim",
      sandbox: bundle.sandbox,
      ctxHandler: noopCtx,
    });

    const expiresAt = (bundle.sandbox.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      .expiresAt as Date;
    const ttlMs = expiresAt.getTime() - before;
    // 60 (default wallClockS) + 30 (REAPER_BACKSTOP_S) = 90s.
    expect(ttlMs).toBeGreaterThanOrEqual(90_000);
    expect(ttlMs).toBeLessThan(95_000);
  });

  it("disposes worker even when invoke fails", async () => {
    const bundle = buildFakeSandbox();
    // Don't auto-respond; child stdin gets task_invoke, no task_result back.
    // Force a synchronous failure path: make execStreaming throw.
    vi.mocked(bundle.sandbox.create).mockResolvedValue({
      state: {
        type: "local-docker",
        taskId: "host-fake",
        containerRowId: "row-1",
        dockerId: "docker-fake",
      },
      exec: vi.fn(),
      execStreaming: vi.fn().mockRejectedValue(new Error("exec blew up")),
    } as unknown as SandboxSession<LocalDockerSessionState>);

    const result = await runOnSysboxContainer({
      taskId: "task-fail",
      skillName: "any",
      body: "async def run(inputs, ctx):\n    return None\n",
      inputs: {},
      image: "python:3.14-slim",
      sandbox: bundle.sandbox,
      ctxHandler: noopCtx,
    });

    expect(result.ok).toBe(false);
    expect(result.workerReusable).toBe(false);
    expect(result.error).toMatch(/exec blew up/);
    // Even on failure, the worker's dispose ran — sandbox.delete called.
    expect(bundle.sandbox.delete).toHaveBeenCalled();
  });

  it("returns ok:false when sandbox.create itself throws (no worker to dispose)", async () => {
    const bundle = buildFakeSandbox();
    vi.mocked(bundle.sandbox.create).mockRejectedValue(new Error("daemon unreachable"));

    const result = await runOnSysboxContainer({
      taskId: "task-no-create",
      skillName: "any",
      body: "async def run(inputs, ctx):\n    return None\n",
      inputs: {},
      image: "python:3.14-slim",
      sandbox: bundle.sandbox,
      ctxHandler: noopCtx,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/daemon unreachable/);
    // sandbox.delete is never called because no session was ever created.
    expect(bundle.sandbox.delete).not.toHaveBeenCalled();
  });

  it("swallows dispose-time errors (logged, not surfaced)", async () => {
    const bundle = buildFakeSandbox();
    autoRespond(bundle, { ok: true, output: null });
    vi.mocked(bundle.sandbox.delete).mockRejectedValue(new Error("daemon vanished"));

    // Despite dispose failing, the original result is preserved.
    const result = await runOnSysboxContainer({
      taskId: "task-bad-dispose",
      skillName: "any",
      body: "async def run(inputs, ctx):\n    return None\n",
      inputs: {},
      image: "python:3.14-slim",
      sandbox: bundle.sandbox,
      ctxHandler: noopCtx,
    });

    expect(result.ok).toBe(true);
  });
});
