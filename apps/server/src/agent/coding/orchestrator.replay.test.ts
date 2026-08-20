/**
 * Inngest replay tests for the plan (`coding-task-start`) and execute
 * (`coding-task-execute`) orchestrators.
 *
 * These drive the real functions through `@inngest/test`, whose engine
 * reproduces Inngest's per-boundary model faithfully: it re-invokes the
 * whole function body once per step boundary, feeding earlier steps back
 * from cache. That is what production does on every clean run — it is not
 * a retry simulation — so anything left in the bare body runs N+1 times
 * for N steps.
 *
 * What these tests pin:
 *   1. The billable CLI session runs exactly once per task, even though the
 *      body around it is re-entered a dozen times.
 *   2. Progress pushes for that session are emitted once, not once per
 *      re-invocation.
 *   3. The execute orchestrator does not short-circuit on a status its own
 *      `set-status-executing` step wrote — the re-entry guard is the
 *      conditional UPDATE's memoized result, not a bare-body read.
 *   4. A genuinely duplicate event still skips, because the conditional
 *      UPDATE matches no row.
 *
 * See .claude/rules/inngest.md and design/crash-recovery.md.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { InngestTestEngine } from "@inngest/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../../inngest/client.js";
import {
  type LocalDockerSessionState,
  LocalDockerSessionStateSchema,
  type SandboxClient,
  type SandboxSession,
} from "../../sandbox/index.js";
import { fakeRunInTx, spyOnInngestSend } from "../../test/factories.js";
import type { CodingBackend, CodingEvent } from "./backend.js";
import {
  type CodingOrchestratorDeps,
  createCodingExecuteOrchestrator,
  createCodingOrchestrator,
  type ExecuteStreamHandle,
  type PlanStreamHandle,
} from "./orchestrator.js";
import type { CodingRepoRow, CodingStore, CodingTaskRow } from "./store/index.js";

const execFileP = promisify(execFile);

const TASK_ID = "01a02000-0000-7000-8000-00000000ta5c";
const REPO_ID = "01a02000-0000-7000-8000-000000007e90";

let baseDir: string;
let repoPath: string;
let sendSpy: ReturnType<typeof spyOnInngestSend>;

beforeAll(async () => {
  // `allocate-worktree` clones for real, so the plan orchestrator needs an
  // actual repository behind `repo.localPath`.
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-replay-test-"));
  repoPath = join(baseDir, "repo");
  await execFileP("git", ["init", "--initial-branch=main", repoPath]);
  await execFileP("git", ["-C", repoPath, "config", "user.email", "t@t"]);
  await execFileP("git", ["-C", repoPath, "config", "user.name", "t"]);
  await execFileP("git", ["-C", repoPath, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoPath, "README.md"), "x");
  await execFileP("git", ["-C", repoPath, "add", "."]);
  await execFileP("git", ["-C", repoPath, "commit", "-m", "init"]);
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

beforeEach(() => {
  // The engine drives `inngest._send` for `step.sendEvent`; without a stub
  // each emit waits out an ECONNREFUSED retry against a dev server that
  // isn't running.
  sendSpy = spyOnInngestSend(inngest);
  sendSpy.mockResolvedValue({ ids: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function repoRow(): CodingRepoRow {
  return {
    id: REPO_ID,
    name: "cogmo",
    localPath: repoPath,
    defaultBranch: "main",
    remoteUrl: "git@github.com:user/cogmo.git",
    devcontainer: null,
    allowedBackends: ["claude"],
    verifyCommand: "true",
    taskTokenBudget: 100_000,
    taskWallTimeSeconds: 600,
    maxConcurrentTasks: 1,
    identityName: "default",
    verifyTimeoutSeconds: 600,
    createdAt: new Date("2026-08-20T00:00:00Z"),
  };
}

function taskRow(overrides: Partial<CodingTaskRow>): CodingTaskRow {
  return {
    id: TASK_ID,
    repoId: REPO_ID,
    conversationId: null,
    goal: "do a thing",
    triggerSource: "user",
    triggerRef: null,
    backend: "claude",
    worktreeAssignment: null,
    sessionId: null,
    containerId: null,
    allowPrivilegedRunc: false,
    plan: null,
    planApprovedAt: null,
    prMetadata: null,
    status: "queued",
    failureReason: null,
    resourceUsage: null,
    createdAt: new Date("2026-08-20T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Store fake whose reads observe its own writes. That property is the whole
 * hazard under per-boundary replay: `getTask` at the top of the body sees
 * the status the run itself committed one boundary earlier, so any guard
 * built on it self-invalidates. A `mock<CodingStore>()` with stateless
 * `mockResolvedValue`s would hide exactly the bug these tests exist for.
 */
function statefulStore(initial: CodingTaskRow): {
  store: CodingStore;
  current: () => CodingTaskRow;
} {
  let task = initial;
  const repo = repoRow();
  const store = mock<CodingStore>();
  store.getTask.mockImplementation(async () => task);
  store.getRepoById.mockImplementation(async () => repo);
  store.updateTaskStatus.mockImplementation(async (_tx, params) => {
    task = {
      ...task,
      status: params.status,
      ...(params.failureReason !== undefined && { failureReason: params.failureReason }),
    };
  });
  store.transitionTaskStatus.mockImplementation(async (_tx, _id, from, to) => {
    if (task.status !== from) return { kind: "stale", status: task.status };
    task = { ...task, status: to };
    return { kind: "transitioned" };
  });
  store.setTaskWorktreeAssignment.mockImplementation(async (_tx, _id, assignment) => {
    task = { ...task, worktreeAssignment: assignment };
  });
  store.setTaskSessionId.mockImplementation(async (_tx, _id, sessionId) => {
    task = { ...task, sessionId };
  });
  store.setTaskPlan.mockImplementation(async (_tx, _id, plan) => {
    task = { ...task, plan };
  });
  store.setTaskContainerId.mockImplementation(async () => {});
  store.setTaskResourceUsage.mockImplementation(async () => {});
  store.setTaskSandboxDeletedAt.mockImplementation(async () => {});
  store.getCodingAutoapproveModeForTask.mockResolvedValue("off");
  return { store, current: () => task };
}

function fakeSandbox(): SandboxClient<LocalDockerSessionState> {
  const state: LocalDockerSessionState = {
    type: "local-docker",
    taskId: TASK_ID,
    containerRowId: "row-1",
    dockerId: "docker-1",
  };
  const session: SandboxSession<LocalDockerSessionState> = {
    state,
    execStreaming: vi.fn(async () => ({
      stdout: process.stdin,
      stderr: process.stdin,
      wait: async () => ({ exitCode: 0 }),
      dispose: async () => {},
    })),
    exec: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      wallTimeSeconds: 0,
      truncated: false,
    })),
  };
  return {
    backendId: "fake",
    capabilities: {
      siblingContainers: "host-proxy",
      hostBindMount: true,
      customImage: true,
      volumes: "docker",
      workingTreeTransport: "bind-mount",
      depsCacheSharing: "shared-volume",
    },
    healthCheck: vi.fn(async () => ({ ok: true as const, runtime: "runc" })),
    reconcileCrashedInstances: vi.fn(async () => ({ orphansReaped: 0 })),
    ensureImagePresent: vi.fn(async () => {}),
    create: vi.fn(async () => session),
    resume: vi.fn(async () => session),
    tryResumeByTaskId: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    deleteByTaskId: vi.fn(async () => {}),
    serializeState: (s) => LocalDockerSessionStateSchema.parse(s),
    deserializeState: (payload) => LocalDockerSessionStateSchema.parse(payload),
    shutdown: vi.fn(async () => {}),
  };
}

const PLAN_EVENTS: CodingEvent[] = [
  { kind: "session_started", sessionId: "sess-AAA" },
  { kind: "text_delta", text: "## Plan\n" },
  { kind: "plan_ready", plan: "## Plan\n1. Do X\n" },
  { kind: "complete", exitCode: 0, isError: false },
];

const EXECUTE_EVENTS: CodingEvent[] = [
  { kind: "session_started", sessionId: "sess-AAA" },
  { kind: "text_delta", text: "Editing foo.ts\n" },
  {
    kind: "complete",
    exitCode: 0,
    isError: false,
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.05 },
  },
];

/** Counts invocations so a per-boundary re-entry shows up as a second call. */
function countingBackend(events: { plan?: CodingEvent[]; execute?: CodingEvent[] }): {
  backend: CodingBackend;
  planCalls: () => number;
  executeCalls: () => number;
} {
  let planCalls = 0;
  let executeCalls = 0;
  return {
    backend: {
      plan: async function* () {
        planCalls++;
        for (const ev of events.plan ?? []) yield ev;
      },
      execute: async function* () {
        executeCalls++;
        for (const ev of events.execute ?? []) yield ev;
      },
    },
    planCalls: () => planCalls,
    executeCalls: () => executeCalls,
  };
}

function recordingPlanStream(): { handle: PlanStreamHandle; text: string[]; finalized: string[] } {
  const text: string[] = [];
  const finalized: string[] = [];
  return {
    text,
    finalized,
    handle: {
      appendText: async (delta) => {
        text.push(delta);
      },
      finalize: async (plan) => {
        finalized.push(plan);
      },
      fail: async () => {},
    },
  };
}

function recordingExecuteStream(): {
  handle: ExecuteStreamHandle;
  started: number;
  text: string[];
} {
  const rec = { started: 0, text: [] as string[] };
  return {
    ...rec,
    get started() {
      return rec.started;
    },
    get text() {
      return rec.text;
    },
    handle: {
      started: async () => {
        rec.started++;
      },
      appendText: async (delta) => {
        rec.text.push(delta);
      },
      toolCall: async () => {},
      toolResult: async () => {},
      complete: async () => {},
      fail: async () => {},
    },
  };
}

function makeDeps(overrides: Partial<CodingOrchestratorDeps>): CodingOrchestratorDeps {
  return {
    runInTx: fakeRunInTx,
    store: mock<CodingStore>(),
    sandbox: fakeSandbox(),
    backend: { plan: async function* () {}, execute: async function* () {} } as CodingBackend,
    devbaseImage: "cogmo/devbase:test",
    defaultResourceLimits: { cpus: 0.5, memory_bytes: 256 * 1024 * 1024, pids: 64 },
    taskTtlMs: 60_000,
    worktreesDir: join(baseDir, "worktrees"),
    askpassBaseDir: join(baseDir, "askpass"),
    ...overrides,
  };
}

describe("coding-task-start — Inngest replay", () => {
  it("runs the billable plan session once across the run's step boundaries", async () => {
    const { store, current } = statefulStore(taskRow({ status: "queued" }));
    const backend = countingBackend({ plan: PLAN_EVENTS });
    const planStream = recordingPlanStream();
    const fn = createCodingOrchestrator(
      makeDeps({
        store,
        backend: backend.backend,
        openPlanStream: async () => planStream.handle,
      }),
      inngest,
    );

    const engine = new InngestTestEngine({
      function: fn,
      events: [{ name: "coding/task/start", data: { taskId: TASK_ID } }],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: "awaiting_approval", plan: "## Plan\n1. Do X\n" });
    expect(current().status).toBe("awaiting_approval");

    // The load-bearing assertion. `backend.plan` spawns a paid `claude -p`
    // session with no `--resume`, so a bare-body call would replan from
    // scratch at each of the ~8 remaining boundaries and re-render the plan
    // into the user's message every time.
    expect(backend.planCalls()).toBe(1);
    expect(planStream.text).toEqual(["## Plan\n"]);
    expect(planStream.finalized).toEqual(["## Plan\n1. Do X\n"]);
  });
});

describe("coding-task-execute — Inngest replay", () => {
  const approvedTask = (): CodingTaskRow =>
    taskRow({
      status: "awaiting_approval",
      planApprovedAt: new Date("2026-08-20T00:01:00Z"),
      sessionId: "sess-AAA",
      plan: "## Plan\n1. Do X\n",
      worktreeAssignment: {
        type: "host-path",
        branch: "cogmo/abc",
        worktreePath: join(baseDir, "worktrees", "cogmo", "abc"),
      },
    });

  const approvedEvent = {
    name: "coding/task/plan-approved",
    data: { taskId: TASK_ID, approvedAt: "2026-08-20T00:01:00.000Z" },
  } as const;

  it("does not short-circuit on the `executing` status its own step wrote", async () => {
    const { store, current } = statefulStore(approvedTask());
    const backend = countingBackend({ execute: EXECUTE_EVENTS });
    const stream = recordingExecuteStream();
    const fn = createCodingExecuteOrchestrator(
      makeDeps({
        store,
        backend: backend.backend,
        openExecuteStream: async () => stream.handle,
      }),
      inngest,
    );

    const engine = new InngestTestEngine({ function: fn, events: [approvedEvent] });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    // `set-status-executing` flips the row to `executing` on the first
    // invocation. Every later re-invocation re-reads that row at the top of
    // the body; a bare-body `status !== "awaiting_approval"` guard would
    // return `skipped` there and strand the task mid-execute.
    expect(result).toEqual({ status: "pending_verify" });
    expect(current().status).toBe("pending_verify");
    expect(backend.executeCalls()).toBe(1);
    expect(stream.started).toBe(1);
    expect(stream.text).toEqual(["Editing foo.ts\n"]);
  });

  it("still skips a duplicate event, because the conditional UPDATE matches no row", async () => {
    // Same shape as above except the row is already terminal — the shape a
    // genuinely duplicate `plan-approved` event finds.
    const { store, current } = statefulStore(
      taskRow({
        ...approvedTask(),
        status: "pr_open",
      }),
    );
    const backend = countingBackend({ execute: EXECUTE_EVENTS });
    const fn = createCodingExecuteOrchestrator(
      makeDeps({ store, backend: backend.backend }),
      inngest,
    );

    const engine = new InngestTestEngine({ function: fn, events: [approvedEvent] });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: "skipped" });
    expect(backend.executeCalls()).toBe(0);
    expect(current().status).toBe("pr_open");
  });
});
