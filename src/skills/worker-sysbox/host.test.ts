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

interface FakeWorker {
  stdin: PassThrough;
  stdout: PassThrough;
  /** Resolve when stdin EOF is observed (host called close). */
  stdinClosed: Promise<void>;
}

/**
 * Build a fake Sandbox whose container `exec` returns piped streams. The
 * test drives the worker side by writing `task_result` / `ctx_call` lines
 * into stdout and reading host messages back from stdin.
 */
function buildFakeSandbox(): {
  sandbox: SandboxClient<LocalDockerSessionState>;
  worker: FakeWorker;
  calls: string[];
} {
  const calls: string[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  let stdinResolve: () => void = () => {};
  const stdinClosed = new Promise<void>((resolve) => {
    stdinResolve = resolve;
  });
  stdin.on("end", () => stdinResolve());
  stdin.on("finish", () => stdinResolve());

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
      taskId: "task",
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
      calls.push(
        `createTaskContainer:${spec.image}:home=${spec.homeVolume?.volumeName ?? "none"}:wt=${spec.worktree?.hostPath ?? "none"}`,
      );
      return session;
    }),
    resume: vi.fn(async () => session),
    tryResumeByTaskId: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    deleteByTaskId: vi.fn(async (id: string) => {
      calls.push(`stopTask:${id}`);
    }),
    serializeState: (state) => LocalDockerSessionStateSchema.parse(state),
    deserializeState: (payload) => LocalDockerSessionStateSchema.parse(payload),
    shutdown: vi.fn(),
  };

  return { sandbox, worker: { stdin, stdout, stdinClosed }, calls };
}

const noopCtx: CtxHandler = { handle: async () => null };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runOnSysboxContainer", () => {
  it("ensures image, creates container with no worktree/home, execs python3, posts task_invoke", async () => {
    const { sandbox, worker, calls } = buildFakeSandbox();

    // Drive the worker: read task_invoke from stdin, then immediately reply
    // with task_result on stdout. Host should resolve.
    const hostMessages: string[] = [];
    worker.stdin.on("data", (chunk) => {
      hostMessages.push(chunk.toString("utf-8"));
      // Inspect arrives as one or more newline-framed JSONs — wait for the
      // task_invoke line then push a result.
      if (hostMessages.join("").includes("task_invoke")) {
        worker.stdout.write(
          `${JSON.stringify({ type: "task_result", id: "task-1", ok: true, output: { ok: 1 } })}\n`,
        );
      }
    });

    const result = await runOnSysboxContainer({
      taskId: "task-1",
      skillName: "echo",
      body: 'async def run(inputs, ctx):\n    return {"ok": 1}\n',
      inputs: { x: 7 },
      image: "python:3.14-slim",
      sandbox,
      ctxHandler: noopCtx,
    });

    expect(result).toMatchObject({ ok: true, output: { ok: 1 }, workerReusable: true });
    expect(calls).toContain("ensureImage:python:3.14-slim");
    expect(calls).toContain("createTaskContainer:python:3.14-slim:home=none:wt=none");
    expect(calls).toContain("exec:python3");
    expect(calls).toContain("stopTask:task-1");

    // First line written to stdin should be the task_invoke for this run.
    const firstLine = hostMessages.join("").split("\n")[0];
    expect(firstLine).toBeDefined();
    const parsed = JSON.parse(firstLine ?? "");
    expect(parsed).toMatchObject({
      type: "task_invoke",
      id: "task-1",
      skill: "echo",
      inputs: { x: 7 },
    });
  });

  it("rejects when runner source exceeds the cmdline cap", async () => {
    const { sandbox } = buildFakeSandbox();
    const giantBody = "x".repeat(200_000);

    const result = await runOnSysboxContainer({
      taskId: "task-2",
      skillName: "huge",
      body: giantBody,
      inputs: {},
      image: "python:3.14-slim",
      sandbox,
      ctxHandler: noopCtx,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/runner source exceeds/);
    // Container must NOT be created when the body is rejected pre-flight.
    expect(sandbox.create).not.toHaveBeenCalled();
  });

  it("services ctx_call mid-task and returns the host's value to the worker", async () => {
    const { sandbox, worker } = buildFakeSandbox();
    const ctx: CtxHandler = {
      handle: async (call) => {
        if (call.method === "now") return "2026-05-07T00:00:00.000Z";
        throw new Error(`unexpected method ${call.method}`);
      },
    };

    // Worker script:
    //  1. wait for task_invoke
    //  2. emit ctx_call now
    //  3. on ctx_result, emit task_result
    let phase: "waiting" | "waiting_ctx" | "done" = "waiting";
    const buf: string[] = [];
    worker.stdin.on("data", (chunk) => {
      buf.push(chunk.toString("utf-8"));
      const all = buf.join("");
      if (phase === "waiting" && all.includes("task_invoke")) {
        phase = "waiting_ctx";
        worker.stdout.write(
          `${JSON.stringify({ type: "ctx_call", id: "ctx-1", method: "now", args: {} })}\n`,
        );
      } else if (phase === "waiting_ctx" && all.includes("ctx_result")) {
        phase = "done";
        worker.stdout.write(
          `${JSON.stringify({ type: "task_result", id: "task-3", ok: true, output: { t: "ok" } })}\n`,
        );
      }
    });

    const result = await runOnSysboxContainer({
      taskId: "task-3",
      skillName: "with-ctx",
      body: "irrelevant",
      inputs: {},
      image: "python:3.14-slim",
      sandbox,
      ctxHandler: ctx,
    });

    expect(result).toMatchObject({ ok: true, output: { t: "ok" }, workerReusable: true });
    // Verify the worker received the ctx_result with the host-supplied value.
    const ctxResultLine = buf
      .join("")
      .split("\n")
      .find((l) => l.includes("ctx_result"));
    expect(ctxResultLine).toBeDefined();
    expect(JSON.parse(ctxResultLine ?? "")).toMatchObject({
      type: "ctx_result",
      id: "ctx-1",
      ok: true,
      value: "2026-05-07T00:00:00.000Z",
    });
  });

  it("kills the container and returns wall_clock_exceeded on timeout", async () => {
    const { sandbox, calls } = buildFakeSandbox();
    // Don't reply with task_result — let the wall-clock timer fire.

    const result = await runOnSysboxContainer({
      taskId: "task-4",
      skillName: "slow",
      body: "irrelevant",
      inputs: {},
      wallClockS: 0.05, // 50 ms
      image: "python:3.14-slim",
      sandbox,
      ctxHandler: noopCtx,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "wall_clock_exceeded",
      workerReusable: false,
    });
    expect(calls).toContain("stopTask:task-4");
  });

  it("surfaces ensureImagePresent failures without creating a container", async () => {
    const { sandbox } = buildFakeSandbox();
    vi.mocked(sandbox.ensureImagePresent).mockRejectedValue(new Error("daemon unreachable"));

    const result = await runOnSysboxContainer({
      taskId: "task-5",
      skillName: "any",
      body: "irrelevant",
      inputs: {},
      image: "python:3.14-slim",
      sandbox,
      ctxHandler: noopCtx,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/daemon unreachable/);
    expect(sandbox.create).not.toHaveBeenCalled();
  });
});
