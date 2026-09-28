import { PassThrough, type Readable, type Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import {
  type ExecStreamingHandle,
  type LocalDockerSessionState,
  LocalDockerSessionStateSchema,
  type SandboxClient,
  type SandboxSession,
} from "../../sandbox/index.js";
import type { CtxHandler } from "../dispatcher.js";
import { type TaskInvoke, TaskInvokeSchema } from "../protocol.js";
import { type InvokeParams, SysboxSkillWorker } from "./worker.js";

const SUPERVISOR_READY = JSON.stringify({ type: "supervisor_ready", protocolVersion: 2 });

/** sha256-shaped, as `task_invoke.lockfileHash` requires. */
const LOCKFILE_HASH = "ab".repeat(32);

interface FakeSandboxBundle {
  sandbox: SandboxClient<LocalDockerSessionState>;
  session: SandboxSession<LocalDockerSessionState>;
  /** stdin we hand to the worker; the test pushes mock task_result lines into stdout. */
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
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
      stdout.write(`${SUPERVISOR_READY}\n`);
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

  return { sandbox, session, stdin, stdout, stderr, execDisposeCalls, calls };
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

/** What the supervisor sends once a task's processes are all gone. */
function taskExited(id: string): string {
  return `${JSON.stringify({ type: "task_exited", id })}\n`;
}

function taskResultLine(id: string, output: unknown): string {
  return `${JSON.stringify({ type: "task_result", id, ok: true, output })}\n`;
}

/** The `task_invoke` frames in a chunk the worker wrote to the supervisor's stdin. */
function taskInvokesIn(chunk: Buffer): TaskInvoke[] {
  return chunk
    .toString("utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .flatMap((line) => {
      const parsed = TaskInvokeSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    });
}

/**
 * Auto-respond to any `task_invoke` line with a matching `task_result` and
 * `task_exited` on stdout. Used by happy-path tests that don't care about
 * ctx bridging. Optionally pre-set the result shape.
 */
function autoRespond(
  bundle: FakeSandboxBundle,
  result: { ok: boolean; output?: unknown; error?: string },
): void {
  bundle.stdin.on("data", (chunk: Buffer) => {
    for (const invoke of taskInvokesIn(chunk)) {
      bundle.stdout.write(`${JSON.stringify({ type: "task_result", id: invoke.id, ...result })}\n`);
      bundle.stdout.write(taskExited(invoke.id));
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

  it("passes depsCacheVolumeName through to sandbox.create as depsCacheVolume", async () => {
    const { sandbox } = buildFakeSandbox();
    await SysboxSkillWorker.create({
      workerId: "w-vol",
      sandbox,
      image: "cogmo-skills:test",
      expiresAt: new Date(Date.now() + 60_000),
      depsCacheVolumeName: "cogmo-skills-deps-cache",
    });
    expect(sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        depsCacheVolume: { volumeName: "cogmo-skills-deps-cache" },
      }),
    );
  });

  it("omits depsCacheVolume from sandbox.create when volume name absent", async () => {
    const { sandbox } = buildFakeSandbox();
    await SysboxSkillWorker.create({
      workerId: "w-novol",
      sandbox,
      image: "cogmo-skills:test",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const spec = vi.mocked(sandbox.create).mock.calls[0]?.[0];
    expect(spec).toBeDefined();
    if (!spec) return;
    expect("depsCacheVolume" in spec).toBe(false);
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

  describe("supervisor handshake", () => {
    /** A supervisor exec whose stdout the test drives, announcing nothing by itself. */
    function silentSupervisor(bundle: FakeSandboxBundle): void {
      vi.mocked(bundle.session.execStreaming).mockImplementation(async () => ({
        stdin: bundle.stdin as unknown as Writable,
        stdout: bundle.stdout as unknown as Readable,
        stderr: new PassThrough() as unknown as Readable,
        wait: async () => ({ exitCode: 0 }),
        dispose: async () => {
          bundle.execDisposeCalls.count += 1;
        },
      }));
    }

    function create(bundle: FakeSandboxBundle): Promise<SysboxSkillWorker> {
      return SysboxSkillWorker.create({
        workerId: "w-hs",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:old",
        expiresAt: new Date(Date.now() + 60_000),
      });
    }

    it("refuses a supervisor announcing another protocol version", async () => {
      const bundle = buildFakeSandbox();
      silentSupervisor(bundle);
      bundle.stdout.write(`${JSON.stringify({ type: "supervisor_ready", protocolVersion: 1 })}\n`);

      await expect(create(bundle)).rejects.toThrow(
        /supervisor speaks protocol v1; this Cogmo requires v2/,
      );
      expect(bundle.execDisposeCalls.count).toBe(1);
      expect(bundle.sandbox.delete).toHaveBeenCalledWith(bundle.session);
    });

    it("refuses an image whose supervisor never announces a protocol", async () => {
      vi.useFakeTimers();
      try {
        const bundle = buildFakeSandbox();
        silentSupervisor(bundle);
        const created = create(bundle);
        const outcome = expect(created).rejects.toThrow(
          /did not announce protocol v2 within 30s; a skills image without the handshake never does/,
        );
        await vi.advanceTimersByTimeAsync(30_000);
        await outcome;
        expect(bundle.execDisposeCalls.count).toBe(1);
        expect(bundle.sandbox.delete).toHaveBeenCalledWith(bundle.session);
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses a supervisor that sends a task frame before announcing", async () => {
      const bundle = buildFakeSandbox();
      silentSupervisor(bundle);
      bundle.stdout.write(taskResultLine("t-early", null));

      await expect(create(bundle)).rejects.toThrow(
        /supervisor sent task_result before supervisor_ready/,
      );
      expect(bundle.execDisposeCalls.count).toBe(1);
      expect(bundle.sandbox.delete).toHaveBeenCalledWith(bundle.session);
    });

    it("refuses a supervisor whose first frame is malformed at once", async () => {
      vi.useFakeTimers();
      try {
        const bundle = buildFakeSandbox();
        silentSupervisor(bundle);
        bundle.stdout.write(`${JSON.stringify({ type: "supervisor_ready" })}\n`);
        let outcome: unknown;
        const created = create(bundle).catch((e: unknown) => {
          outcome = e;
        });
        await vi.advanceTimersByTimeAsync(0);
        // Refused on the frame itself, not at the handshake deadline.
        expect(String(outcome)).toMatch(
          /supervisor sent a malformed frame before supervisor_ready/,
        );
        await created;
        expect(bundle.sandbox.delete).toHaveBeenCalledWith(bundle.session);
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses a supervisor that exits before announcing", async () => {
      const bundle = buildFakeSandbox();
      silentSupervisor(bundle);
      bundle.stdout.end();

      await expect(create(bundle)).rejects.toThrow(/supervisor exited before announcing/);
      expect(bundle.sandbox.delete).toHaveBeenCalledWith(bundle.session);
    });

    it("reports a handshake the host cut short as closed, not as the supervisor exiting", async () => {
      const bundle = buildFakeSandbox();
      silentSupervisor(bundle);
      const lifetime = new AbortController();
      const created = SysboxSkillWorker.create({
        workerId: "w-closed",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
        signal: lifetime.signal,
      });
      await vi.waitFor(() => expect(bundle.session.execStreaming).toHaveBeenCalled());
      lifetime.abort(new Error("pool disposed"));

      await expect(created).rejects.toThrow(
        /host closed the supervisor's channel before it announced: pool disposed/,
      );
      expect(bundle.sandbox.delete).toHaveBeenCalledWith(bundle.session);
    });
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
      expect(w.tryAcquire().isOk()).toBe(true);
      expect(w.state).toBe("busy");
      expect(w.tryAcquire().isErr()).toBe(true);
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
      w.retire();
      w.release();
      expect(w.state).toBe("dead");
    });

    it("retire makes the worker dead; idempotent; no-op once disposed", async () => {
      const { sandbox } = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-5",
        sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.retire();
      expect(w.state).toBe("dead");
      w.retire();
      expect(w.state).toBe("dead");
      await w.dispose();
      w.retire();
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
        /SysboxSkillWorker.invoke: cannot invoke on a worker that is idle: acquire it first/,
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

      expect(w.tryAcquire().isOk()).toBe(true);
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

    it("`isolation: recycle` retires the worker after the task runs", async () => {
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
      expect(w.state).toBe("dead");
    });

    it("with deps: populates venv and threads skill_venv into task_invoke", async () => {
      // Two distinct execs in this scenario: the supervisor (long-lived,
      // started at create) and the per-task populate (short-lived `sh -c`).
      // Discriminate via the literal "populate" argv0 sentinel set at
      // argv[3] — the call site put it there for exactly this purpose.
      const bundle = buildFakeSandbox();
      const populateStderr = new PassThrough();
      vi.mocked(bundle.session.execStreaming).mockImplementation(async (cmd) => {
        bundle.calls.push(`exec:${cmd[0]}`);
        if (cmd[3] === "populate") {
          // Populate exec — wait resolves immediately to exit 0.
          return {
            stdin: new PassThrough() as unknown as Writable,
            stdout: new PassThrough() as unknown as Readable,
            stderr: populateStderr as unknown as Readable,
            wait: async () => ({ exitCode: 0 }),
            dispose: async () => {},
          };
        }
        // Supervisor exec — same shape as buildFakeSandbox's default.
        bundle.stdout.write(`${SUPERVISOR_READY}\n`);
        return {
          stdin: bundle.stdin as unknown as Writable,
          stdout: bundle.stdout as unknown as Readable,
          stderr: new PassThrough() as unknown as Readable,
          wait: async () => ({ exitCode: 0 }),
          dispose: async () => {
            bundle.execDisposeCalls.count += 1;
          },
        };
      });

      // Capture the task_invoke line so we can assert on `lockfileHash`.
      const taskInvokes: TaskInvoke[] = [];
      bundle.stdin.on("data", (chunk: Buffer) => {
        for (const invoke of taskInvokesIn(chunk)) {
          taskInvokes.push(invoke);
          bundle.stdout.write(taskResultLine(invoke.id, { ok: 1 }));
          bundle.stdout.write(taskExited(invoke.id));
        }
      });

      const w = await SysboxSkillWorker.create({
        workerId: "w-deps",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      const r = await w.invoke({
        ...invokeParams("t-deps"),
        deps: {
          lockfileHash: LOCKFILE_HASH,
          lockfileContents: "httpx==0.27.0 --hash=sha256:0\n",
        },
      });

      expect(r.ok).toBe(true);
      expect(r.workerReusable).toBe(true);
      // Populate exec ran (sh + supervisor python3, in some order).
      expect(bundle.calls).toContain("exec:sh");
      // Task invoke carried the venv path.
      expect(taskInvokes[0]?.lockfileHash).toBe(LOCKFILE_HASH);
    });

    it("with deps: populate_failed retires the worker, no task is invoked", async () => {
      const bundle = buildFakeSandbox();
      vi.mocked(bundle.session.execStreaming).mockImplementation(async (cmd) => {
        if (cmd[3] === "populate") {
          // Populate exec — emit a hash-mismatch stderr and exit 1.
          // The stderr listener attaches synchronously after the handle
          // is returned; we hold `wait()` until the next microtask so
          // the listener observes the bytes before the result settles.
          const populateStderr = new PassThrough();
          populateStderr.write("error: hash mismatch on httpx-0.27.0\n");
          populateStderr.end();
          return {
            stdin: new PassThrough() as unknown as Writable,
            stdout: new PassThrough() as unknown as Readable,
            stderr: populateStderr as unknown as Readable,
            wait: async () => {
              // Drain the stderr stream's queued chunks into the
              // listener before resolving. One macrotask is enough.
              await new Promise<void>((r) => setImmediate(r));
              return { exitCode: 1 };
            },
            dispose: async () => {},
          };
        }
        bundle.stdout.write(`${SUPERVISOR_READY}\n`);
        return {
          stdin: bundle.stdin as unknown as Writable,
          stdout: bundle.stdout as unknown as Readable,
          stderr: new PassThrough() as unknown as Readable,
          wait: async () => ({ exitCode: 0 }),
          dispose: async () => {
            bundle.execDisposeCalls.count += 1;
          },
        };
      });

      // Track any task_invoke — should NOT see one when populate fails.
      const taskInvokes: TaskInvoke[] = [];
      bundle.stdin.on("data", (chunk: Buffer) => {
        taskInvokes.push(...taskInvokesIn(chunk));
      });

      const w = await SysboxSkillWorker.create({
        workerId: "w-deps-fail",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      const r = await w.invoke({
        ...invokeParams("t-fail"),
        deps: {
          lockfileHash: LOCKFILE_HASH,
          lockfileContents: "httpx==0.27.0\n",
        },
      });

      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/skill_venv_populate_failed/);
      expect(r.error).toMatch(/hash mismatch/);
      expect(r.workerReusable).toBe(false);
      expect(w.state).toBe("dead");
      expect(taskInvokes).toHaveLength(0);
    });

    it("fails a task on a worker that died after its lease as a value, populating nothing", async () => {
      const bundle = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-dead-leased",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      bundle.stdout.end();
      await w.dead;

      const r = await w.invoke({
        ...invokeParams("t-dead"),
        deps: { lockfileHash: LOCKFILE_HASH, lockfileContents: "httpx==0.27.0\n" },
      });

      expect(r).toEqual({
        ok: false,
        error: "dispatcher_error: worker is dead: worker closed its output",
        workerReusable: false,
      });
      // Only the supervisor was ever started: no populate ran.
      expect(bundle.session.execStreaming).toHaveBeenCalledTimes(1);
    });

    it("fails the task as a value when the supervisor dies during its venv populate", async () => {
      const bundle = buildFakeSandbox();
      vi.mocked(bundle.session.execStreaming).mockImplementation(async (cmd) => {
        if (cmd[3] === "populate") {
          return {
            stdin: new PassThrough() as unknown as Writable,
            stdout: new PassThrough() as unknown as Readable,
            stderr: new PassThrough() as unknown as Readable,
            wait: async () => {
              // The supervisor dies while uv pip sync runs.
              bundle.stdout.end();
              await new Promise<void>((r) => setImmediate(r));
              return { exitCode: 0 };
            },
            dispose: async () => {},
          };
        }
        bundle.stdout.write(`${SUPERVISOR_READY}\n`);
        return {
          stdin: bundle.stdin as unknown as Writable,
          stdout: bundle.stdout as unknown as Readable,
          stderr: new PassThrough() as unknown as Readable,
          wait: async () => ({ exitCode: 0 }),
          dispose: async () => {},
        };
      });
      const w = await SysboxSkillWorker.create({
        workerId: "w-venv-death",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();

      const r = await w.invoke({
        ...invokeParams("t-venv-death"),
        deps: { lockfileHash: LOCKFILE_HASH, lockfileContents: "httpx==0.27.0\n" },
      });

      expect(r).toEqual({
        ok: false,
        error: "dispatcher_error: worker is dead: worker closed its output",
        workerReusable: false,
      });
      expect(w.state).toBe("dead");
    });

    it("returns only once the supervisor confirms the task's processes exited", async () => {
      const bundle = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-exit",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      vi.useFakeTimers();
      try {
        let settled = false;
        const pending = w.invoke(invokeParams("t-exit")).then((r) => {
          settled = true;
          return r;
        });
        await vi.advanceTimersByTimeAsync(0);
        bundle.stdout.write(taskResultLine("t-exit", 1));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(settled).toBe(false);

        bundle.stdout.write(taskExited("t-exit"));
        await expect(pending).resolves.toMatchObject({ ok: true, output: 1, workerReusable: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a delivered result when the supervisor's output closes before task_exited", async () => {
      const bundle = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-eof",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      const pending = w.invoke(invokeParams("t-eof"));
      await new Promise((r) => setImmediate(r));
      bundle.stdout.write(taskResultLine("t-eof", 1));
      bundle.stdout.end();

      await expect(pending).resolves.toEqual({ ok: true, output: 1, workerReusable: false });
      expect(w.state).toBe("dead");
    });

    it("fails the task when the supervisor's output closes before its result", async () => {
      const bundle = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-eof-early",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      const pending = w.invoke(invokeParams("t-eof-early"));
      await new Promise((r) => setImmediate(r));
      bundle.stdout.end();

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/worker closed its output/),
        workerReusable: false,
      });
      expect(w.state).toBe("dead");
    });

    it("fails the task as a value when its exec's socket fails, with nothing left unhandled", async () => {
      const uncaught = vi.fn();
      process.on("uncaughtException", uncaught);
      try {
        const bundle = buildFakeSandbox();
        const w = await SysboxSkillWorker.create({
          workerId: "w-socket-error",
          sandbox: bundle.sandbox,
          image: "cogmo-skills:test",
          expiresAt: new Date(Date.now() + 60_000),
        });
        w.tryAcquire();
        const pending = w.invoke(invokeParams("t-socket-error"));
        await new Promise((r) => setImmediate(r));
        // The sandbox forwards an exec socket error to both demuxed streams.
        const reset = new Error("read ECONNRESET");
        bundle.stdout.destroy(reset);
        bundle.stderr.destroy(reset);

        await expect(pending).resolves.toMatchObject({
          ok: false,
          error: expect.stringMatching(/read ECONNRESET/),
          workerReusable: false,
        });
        await new Promise((r) => setImmediate(r));
        expect(uncaught).not.toHaveBeenCalled();
      } finally {
        process.off("uncaughtException", uncaught);
      }
    });

    it("keeps a delivered result when the host watchdog fires before task_exited", async () => {
      const bundle = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-hung-after",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      vi.useFakeTimers();
      try {
        const pending = w.invoke({ ...invokeParams("t-hung-after"), wallClockS: 1 });
        await vi.advanceTimersByTimeAsync(0);
        bundle.stdout.write(taskResultLine("t-hung-after", 1));
        await vi.advanceTimersByTimeAsync(11_000);
        await expect(pending).resolves.toEqual({ ok: true, output: 1, workerReusable: false });
      } finally {
        vi.useRealTimers();
      }
      expect(w.state).toBe("dead");
    });

    it("retires itself when its supervisor dies while idle", async () => {
      const bundle = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-idle-death",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      bundle.stdout.end();
      await new Promise((r) => setImmediate(r));

      expect(w.state).toBe("dead");
      expect(w.tryAcquire().isErr()).toBe(true);
    });

    it("does not serve the previous task's late ctx_call with the next task's handler", async () => {
      const bundle = buildFakeSandbox();
      bundle.stdin.on("data", (chunk: Buffer) => {
        for (const invoke of taskInvokesIn(chunk)) {
          if (invoke.id === "t-B") {
            // Task A's code is still running and calls ctx while B is in flight.
            bundle.stdout.write(
              `${JSON.stringify({ type: "ctx_call", id: "ctx-late", taskId: "t-A", method: "secrets.get", args: { name: "token" } })}\n`,
            );
          }
          bundle.stdout.write(taskResultLine(invoke.id, invoke.id));
          bundle.stdout.write(taskExited(invoke.id));
        }
      });
      const w = await SysboxSkillWorker.create({
        workerId: "w-late",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handlerA = mock<CtxHandler>();
      const handlerB = mock<CtxHandler>();

      w.tryAcquire();
      await w.invoke({ ...invokeParams("t-A"), ctxHandler: handlerA });
      w.release();
      w.tryAcquire();
      await w.invoke({ ...invokeParams("t-B"), ctxHandler: handlerB });

      expect(handlerA.handle).not.toHaveBeenCalled();
      expect(handlerB.handle).not.toHaveBeenCalled();
    });

    it("host watchdog fires when supervisor never replies (retires worker)", async () => {
      // Supervisor stub never writes a task_result. The host-side watchdog
      // (= wallClockS + 10s grace) fires; worker reports
      // `supervisor_unresponsive` and dies.
      const bundle = buildFakeSandbox();
      // No autoRespond — stub stays silent.
      const w = await SysboxSkillWorker.create({
        workerId: "w-hung",
        sandbox: bundle.sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      w.tryAcquire();
      vi.useFakeTimers();
      try {
        const pending = w.invoke({ ...invokeParams("t-hung"), wallClockS: 1 });
        await vi.advanceTimersByTimeAsync(10_999);
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toMatchObject({
          ok: false,
          error: "supervisor_unresponsive",
          workerReusable: false,
        });
      } finally {
        vi.useRealTimers();
      }
      expect(w.state).toBe("dead");
    });
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

    it("swallows exec.dispose failures during dispose", async () => {
      // Same as above but the exec handle's dispose is what fails. Worker
      // logs and continues; sandbox.delete still runs. Pins the
      // "dispose is best-effort" contract.
      const bundle = buildFakeSandbox();
      // Re-create the session with a failing exec.dispose. Ugly because
      // execDisposeCalls is wired in buildFakeSandbox; just override.
      const failingStdout = new PassThrough();
      failingStdout.write(`${SUPERVISOR_READY}\n`);
      const failingExec: ExecStreamingHandle = {
        stdin: new PassThrough() as unknown as Writable,
        stdout: failingStdout as unknown as Readable,
        stderr: new PassThrough() as unknown as Readable,
        wait: async () => ({ exitCode: 0 }),
        dispose: async () => {
          throw new Error("exec dispose failed");
        },
      };
      vi.mocked(bundle.session.execStreaming).mockResolvedValue(failingExec);

      const w = await SysboxSkillWorker.create({
        workerId: "w-exec-fail",
        sandbox: bundle.sandbox,
        image: "python:3.14-slim",
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(w.dispose()).resolves.toBeUndefined();
      expect(w.state).toBe("disposed");
      // sandbox.delete still ran despite exec.dispose throwing.
      expect(bundle.sandbox.delete).toHaveBeenCalled();
    });
  });

  describe("death", () => {
    it("resolves dead the moment its supervisor goes away", async () => {
      const bundle = buildFakeSandbox();
      const w = await SysboxSkillWorker.create({
        workerId: "w-dead",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      bundle.stdout.end();
      await expect(w.dead).resolves.toMatch(/worker closed its output/);
    });

    it("dies when its signal aborts, closing the supervisor's stdin", async () => {
      const bundle = buildFakeSandbox();
      const lifetime = new AbortController();
      const w = await SysboxSkillWorker.create({
        workerId: "w-signal",
        sandbox: bundle.sandbox,
        image: "cogmo-skills:test",
        expiresAt: new Date(Date.now() + 60_000),
        signal: lifetime.signal,
      });
      lifetime.abort(new Error("pool disposed"));
      await expect(w.dead).resolves.toBe("pool disposed");
      expect(w.state).toBe("dead");
      expect(bundle.stdin.writableEnded).toBe(true);
    });

    it("creates nothing once its signal has aborted", async () => {
      const bundle = buildFakeSandbox();
      await expect(
        SysboxSkillWorker.create({
          workerId: "w-aborted",
          sandbox: bundle.sandbox,
          image: "cogmo-skills:test",
          expiresAt: new Date(Date.now() + 60_000),
          signal: AbortSignal.abort(new Error("pool disposed")),
        }),
      ).rejects.toThrow(/pool disposed/);
      expect(bundle.sandbox.ensureImagePresent).not.toHaveBeenCalled();
      expect(bundle.sandbox.create).not.toHaveBeenCalled();
    });

    it("stops a spawn whose signal aborts while its container is created, and deletes it", async () => {
      const bundle = buildFakeSandbox();
      const lifetime = new AbortController();
      vi.mocked(bundle.sandbox.create).mockImplementation(async () => {
        lifetime.abort(new Error("pool disposed"));
        return bundle.session;
      });
      await expect(
        SysboxSkillWorker.create({
          workerId: "w-aborting",
          sandbox: bundle.sandbox,
          image: "cogmo-skills:test",
          expiresAt: new Date(Date.now() + 60_000),
          signal: lifetime.signal,
        }),
      ).rejects.toThrow(/pool disposed/);
      expect(bundle.session.execStreaming).not.toHaveBeenCalled();
      expect(bundle.sandbox.delete).toHaveBeenCalledWith(bundle.session);
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
