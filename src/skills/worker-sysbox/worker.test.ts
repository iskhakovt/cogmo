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
import { type InvokeParams, SysboxSkillWorker } from "./worker.js";

interface FakeSandboxBundle {
  sandbox: SandboxClient<LocalDockerSessionState>;
  session: SandboxSession<LocalDockerSessionState>;
  /** stdin we hand to the worker; the test pushes mock task_result lines into stdout. */
  stdin: PassThrough;
  stdout: PassThrough;
  /** exec.dispose call count — the worker calls dispose during teardown. */
  execDisposeCalls: { count: number };
  /** Calls captured for assertion. */
  calls: string[];
}

function buildFakeSandbox(): FakeSandboxBundle {
  const calls: string[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const execDisposeCalls = { count: 0 };

  const exec: ExecStreamingHandle = {
    stdin: stdin as unknown as Writable,
    stdout: stdout as unknown as Readable,
    stderr: stderr as unknown as Readable,
    wait: async () => ({ exitCode: 0 }),
    dispose: async () => {
      execDisposeCalls.count += 1;
    },
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

  return { sandbox, session, stdin, stdout, execDisposeCalls, calls };
}

const noopCtx: CtxHandler = { handle: async () => null };

function invokeParams(taskId: string): InvokeParams {
  return {
    taskId,
    skillName: "test",
    body: 'async def run(inputs, ctx):\n    return {"ok": 1}\n',
    inputs: {},
    ctxHandler: noopCtx,
  };
}

/**
 * Auto-respond to any `task_invoke` line by echoing a matching `task_result`
 * back on stdout. Used by happy-path tests that don't care about ctx
 * bridging. Optionally pre-set the result shape.
 */
function autoRespond(
  bundle: FakeSandboxBundle,
  result: { ok: boolean; output?: unknown; error?: string },
): void {
  bundle.stdin.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    const lines = text.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as { type?: unknown; id?: unknown };
        if (msg.type === "task_invoke" && typeof msg.id === "string") {
          bundle.stdout.write(
            `${JSON.stringify({ type: "task_result", id: msg.id, ...result })}\n`,
          );
        }
      } catch {
        // ignore non-json (test harness shouldn't send non-json)
      }
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SysboxSkillWorker", () => {
  it("ensures image, creates session, spawns supervisor exec at construction", async () => {
    const { sandbox, calls } = buildFakeSandbox();
    const worker = await SysboxSkillWorker.create({
      workerId: "w-1",
      sandbox,
      image: "python:3.14-slim",
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(calls).toContain("ensureImage:python:3.14-slim");
    expect(calls).toContain("create:w-1:python:3.14-slim");
    expect(calls).toContain("exec:python3");
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
      resourceLimits: { memory_bytes: 256 * 1024 * 1024 },
    });
    expect(sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceLimits: expect.objectContaining({
          memory_bytes: 256 * 1024 * 1024,
          cpus: 1,
          pids: 1024,
        }),
      }),
    );
  });

  it("disposes session if execStreaming throws after create", async () => {
    const bundle = buildFakeSandbox();
    vi.mocked(bundle.session.execStreaming).mockRejectedValueOnce(new Error("exec failed"));
    await expect(
      SysboxSkillWorker.create({
        workerId: "w-fail",
        sandbox: bundle.sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/exec failed/);
    // Session must be cleaned up so the container doesn't leak when the
    // supervisor process couldn't even start.
    expect(bundle.sandbox.delete).toHaveBeenCalled();
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
      expect(w.tryAcquire()).toBe(false);
    });

    it("release flips busy → idle (and is a no-op from any other state)", async () => {
      const { sandbox } = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-4",
        sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.release();
      expect(w.state).toBe("idle");
      w.tryAcquire();
      w.release();
      expect(w.state).toBe("idle");
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
      expect(w.state).toBe("draining");
      await w.dispose();
      w.markPoisoned();
      expect(w.state).toBe("disposed");
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

    it("happy path: increments taskCount, returns task_result, stays busy", async () => {
      const bundle = buildFakeSandbox();
      autoRespond(bundle, { ok: true, output: { x: 1 } });
      const w = await SysboxSkillWorker.create({
        workerId: "w-7",
        sandbox: bundle.sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });

      expect(w.tryAcquire()).toBe(true);
      const r = await w.invoke(invokeParams("t-7"));
      expect(r).toMatchObject({ ok: true, output: { x: 1 }, workerReusable: true });
      expect(w.taskCount).toBe(1);
      // Pool — not the worker — calls release; worker stays busy.
      expect(w.state).toBe("busy");
    });

    it("supervisor-emitted error keeps the worker reusable (supervisor still alive)", async () => {
      // In B.2 the supervisor handles wall-clock kill internally and emits
      // the wall_clock_exceeded task_result; the supervisor process itself
      // stays alive and ready for the next task. This is a behaviour
      // change from B.1 where wall-clock killed the whole container.
      const bundle = buildFakeSandbox();
      autoRespond(bundle, { ok: false, error: "wall_clock_exceeded" });
      const w = await SysboxSkillWorker.create({
        workerId: "w-walltime",
        sandbox: bundle.sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      const r = await w.invoke(invokeParams("t-wt"));
      expect(r).toMatchObject({
        ok: false,
        error: "wall_clock_exceeded",
        workerReusable: true,
      });
      expect(w.state).toBe("busy");
    });

    it("`isolation: recycle` poisons the worker after the task runs", async () => {
      const bundle = buildFakeSandbox();
      autoRespond(bundle, { ok: true, output: null });
      const w = await SysboxSkillWorker.create({
        workerId: "w-recycle",
        sandbox: bundle.sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      const r = await w.invoke({ ...invokeParams("t-r"), isolation: "recycle" });
      expect(r.ok).toBe(true);
      expect(r.workerReusable).toBe(false);
      expect(w.state).toBe("draining");
    });

    it("host watchdog fires when supervisor never replies (poisons worker)", async () => {
      // Supervisor stub never writes a task_result. The host-side watchdog
      // (= wallClockS + 5s grace) fires; worker reports
      // `supervisor_unresponsive` and goes draining. wallClockS=0.05 keeps
      // the test under 6 seconds total.
      const bundle = buildFakeSandbox();
      // No autoRespond — stub stays silent.
      const w = await SysboxSkillWorker.create({
        workerId: "w-hung",
        sandbox: bundle.sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      const r = await w.invoke({ ...invokeParams("t-hung"), wallClockS: 0.05 });
      expect(r).toMatchObject({
        ok: false,
        error: "supervisor_unresponsive",
        workerReusable: false,
      });
      expect(w.state).toBe("draining");
    }, 10_000);
  });

  describe("dispose", () => {
    it("closes dispatcher, calls exec.dispose, calls sandbox.delete; idempotent", async () => {
      const bundle = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-10",
        sandbox: bundle.sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      await w.dispose();
      expect(bundle.execDisposeCalls.count).toBe(1);
      expect(bundle.sandbox.delete).toHaveBeenCalledWith(bundle.session);
      expect(w.state).toBe("disposed");
      await w.dispose();
      expect(bundle.sandbox.delete).toHaveBeenCalledTimes(1);
      expect(bundle.execDisposeCalls.count).toBe(1);
    });

    it("swallows sandbox.delete failures during dispose", async () => {
      const { sandbox } = buildFakeSandbox();
      vi.mocked(sandbox.delete).mockRejectedValue(new Error("daemon vanished"));
      const w = await SysboxSkillWorker.create({
        workerId: "w-11",
        sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
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
