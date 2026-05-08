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
import type { RunTaskOnSessionParams } from "./host.js";
import { SysboxSkillWorker } from "./worker.js";

interface FakeSandboxBundle {
  sandbox: SandboxClient<LocalDockerSessionState>;
  session: SandboxSession<LocalDockerSessionState>;
  /** stdin we hand to the worker; the test pushes mock task_result lines into stdout. */
  stdin: PassThrough;
  stdout: PassThrough;
  /** Calls captured for assertion. */
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
    dispose: async () => {},
  };

  const session: SandboxSession<LocalDockerSessionState> = {
    state: {
      type: "local-docker",
      taskId: "worker-fake",
      containerRowId: "row-1",
      dockerId: "docker-fake",
    },
    exec: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      wallTimeSeconds: 0,
      truncated: false,
    })),
    execStreaming: vi.fn(async (cmd) => {
      calls.push(`exec:${cmd[0]}`);
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

  return { sandbox, session, stdin, stdout, calls };
}

const noopCtx: CtxHandler = { handle: async () => null };

function invokeParams(taskId: string): RunTaskOnSessionParams & { ctxHandler: CtxHandler } {
  return {
    taskId,
    skillName: "test",
    body: 'async def run(inputs, ctx):\n    return {"ok": 1}\n',
    inputs: {},
    ctxHandler: noopCtx,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SysboxSkillWorker", () => {
  it("ensures image and creates a session at construction time", async () => {
    const { sandbox, calls } = buildFakeSandbox();
    const worker = await SysboxSkillWorker.create({
      workerId: "w-1",
      sandbox,
      image: "python:3.14-slim",
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(calls).toContain("ensureImage:python:3.14-slim");
    expect(calls).toContain("create:w-1:python:3.14-slim");
    expect(worker.workerId).toBe("w-1");
    expect(worker.state).toBe("idle");
    expect(worker.taskCount).toBe(0);
  });

  it("merges per-skill resource overrides on top of defaults", async () => {
    const { sandbox } = buildFakeSandbox();
    await SysboxSkillWorker.create({
      workerId: "w-2",
      sandbox,
      image: "python:3.14-slim",
      expiresAt: new Date(Date.now() + 60_000),
      resourceLimits: { memory_bytes: 256 * 1024 * 1024 }, // overrides default
    });
    expect(sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceLimits: expect.objectContaining({
          memory_bytes: 256 * 1024 * 1024,
          cpus: 1, // default
          pids: 1024, // default
        }),
      }),
    );
  });

  describe("state transitions", () => {
    it("tryAcquire flips idle → busy and rejects when not idle", async () => {
      const { sandbox } = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-3",
        sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(w.tryAcquire()).toBe(true);
      expect(w.state).toBe("busy");
      expect(w.tryAcquire()).toBe(false); // already busy
    });

    it("release flips busy → idle (and is a no-op from any other state)", async () => {
      const { sandbox } = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-4",
        sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      // Idle → release → still idle
      w.release();
      expect(w.state).toBe("idle");
      // Busy → release → idle
      w.tryAcquire();
      w.release();
      expect(w.state).toBe("idle");
      // Draining → release → still draining
      w.markPoisoned();
      w.release();
      expect(w.state).toBe("draining");
    });

    it("markPoisoned flips to draining; idempotent; no-op once disposed", async () => {
      const { sandbox } = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-5",
        sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.markPoisoned();
      expect(w.state).toBe("draining");
      w.markPoisoned();
      expect(w.state).toBe("draining"); // idempotent
      await w.dispose();
      w.markPoisoned();
      expect(w.state).toBe("disposed"); // no transition out of disposed
    });
  });

  describe("invoke", () => {
    it("rejects when called outside busy state", async () => {
      const { sandbox } = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-6",
        sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(w.invoke(invokeParams("t-1"))).rejects.toThrow(
        /SysboxSkillWorker.invoke called in state 'idle'/,
      );
    });

    it("happy path: increments taskCount, advances lastUsedAt, stays busy until release", async () => {
      const bundle = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-7",
        sandbox: bundle.sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });

      // Wire stdin → stdout: when host writes task_invoke, push back task_result.
      bundle.stdin.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("task_invoke")) {
          bundle.stdout.write(
            `${JSON.stringify({ type: "task_result", id: "t-7", ok: true, output: { x: 1 } })}\n`,
          );
        }
      });

      const before = w.idleMs(Date.now());
      expect(before).toBeGreaterThanOrEqual(0);
      expect(w.tryAcquire()).toBe(true);
      const r = await w.invoke(invokeParams("t-7"));
      expect(r).toMatchObject({ ok: true, workerReusable: true });
      expect(w.taskCount).toBe(1);
      expect(w.state).toBe("busy"); // pool, not worker, calls release
    });

    it("non-reusable result transitions worker to draining", async () => {
      const bundle = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-8",
        sandbox: bundle.sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      // Don't reply with task_result. With a 50ms wall-clock the host kills
      // and reports workerReusable: false.
      w.tryAcquire();
      const result = await w.invoke({ ...invokeParams("t-8"), wallClockS: 0.05 });
      expect(result).toMatchObject({
        ok: false,
        error: "wall_clock_exceeded",
        workerReusable: false,
      });
      expect(w.state).toBe("draining");
      expect(w.taskCount).toBe(1);
    });

    it("synchronous exception inside runTaskOnSession marks worker poisoned", async () => {
      const bundle = buildFakeSandbox();
      // Force execStreaming to throw — surfaces as a synchronous exception
      // through `runTaskOnSession`'s catch path.
      vi.mocked(bundle.session.execStreaming).mockRejectedValue(new Error("docker hiccup"));
      const w = await SysboxSkillWorker.create({
        workerId: "w-9",
        sandbox: bundle.sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      const result = await w.invoke(invokeParams("t-9"));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/worker_exception: docker hiccup/);
      expect(result.workerReusable).toBe(false);
      expect(w.state).toBe("draining");
    });
  });

  describe("dispose", () => {
    it("calls sandbox.delete and is idempotent", async () => {
      const { sandbox, session } = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-10",
        sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      await w.dispose();
      expect(sandbox.delete).toHaveBeenCalledWith(session);
      expect(w.state).toBe("disposed");
      await w.dispose();
      // Second dispose doesn't re-call sandbox.delete.
      expect(sandbox.delete).toHaveBeenCalledTimes(1);
    });

    it("swallows sandbox.delete failures (logged, not surfaced)", async () => {
      const { sandbox } = buildFakeSandbox();
      vi.mocked(sandbox.delete).mockRejectedValue(new Error("daemon vanished"));
      const w = await SysboxSkillWorker.create({
        workerId: "w-11",
        sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      // Must not throw — recycle paths fire-and-forget dispose.
      await expect(w.dispose()).resolves.toBeUndefined();
      expect(w.state).toBe("disposed");
    });
  });

  describe("clocks", () => {
    it("idleMs and ageMs clamp at zero for clocks that go backwards", async () => {
      const { sandbox } = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-12",
        sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const past = Date.now() - 10_000;
      expect(w.idleMs(past)).toBe(0);
      expect(w.ageMs(past)).toBe(0);
    });
  });
});
