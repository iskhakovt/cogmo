import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../../db/index.js";
import {
  type ExecStreamingHandle,
  type LocalDockerSessionState,
  LocalDockerSessionStateSchema,
  type SandboxClient,
  type SandboxSession,
} from "../../sandbox/index.js";
import { DrizzleSandboxStore } from "../../sandbox/store/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import type { CodingBackend, CodingEvent } from "./backend.js";
import {
  type CodingOrchestratorDeps,
  type ExecuteStreamHandle,
  NULL_EXECUTE_STREAM,
  NULL_PLAN_STREAM,
  runCodingExecute,
  runCodingTask,
  type StepRun,
} from "./orchestrator.js";
import { type CodingRepoRow, type CodingTaskRow, DrizzleCodingStore } from "./store/index.js";

const execFileP = promisify(execFile);

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleCodingStore;
let sandboxStore: DrizzleSandboxStore;
let instanceId: string;
let baseDir: string;
let repoPath: string;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleCodingStore();
  sandboxStore = new DrizzleSandboxStore();

  baseDir = mkdtempSync(join(tmpdir(), "cogmo-orch-test-"));
  repoPath = join(baseDir, "repo");
  await execFileP("git", ["init", "--initial-branch=main", repoPath]);
  await execFileP("git", ["-C", repoPath, "config", "user.email", "t@t"]);
  await execFileP("git", ["-C", repoPath, "config", "user.name", "t"]);
  await execFileP("git", ["-C", repoPath, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoPath, "README.md"), "x");
  await execFileP("git", ["-C", repoPath, "add", "."]);
  await execFileP("git", ["-C", repoPath, "commit", "-m", "init"]);
});

beforeEach(async () => {
  // Fresh cogmo_instances row per test so the FK from containers.instance_id
  // is satisfied when the fake sandbox inserts containers rows.
  instanceId = (await tx((trx) => sandboxStore.insertInstance(trx, { host: "test", pid: 1 }))).id;
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  rmSync(baseDir, { recursive: true, force: true });
  await close();
});

// Shim mirroring `step.run`'s signature. Production has Inngest's real
// step.run (return type Jsonify<T>); tests run the body inline. Cast at
// the seam — explicitly justified per CLAUDE.md "intentionally invalid
// input in tests".
const stepRun = ((_: string, fn: () => Promise<unknown>) => fn()) as any as StepRun;

const RESOURCE_LIMITS = { cpus: 0.5, memory_bytes: 256 * 1024 * 1024, pids: 64 };

async function seedRepo(name = "cogmo"): Promise<CodingRepoRow> {
  return tx((trx) =>
    store.insertRepo(trx, {
      name,
      localPath: repoPath,
      defaultBranch: "main",
      remoteUrl: "git@github.com:user/cogmo.git",
      devcontainer: null,
      allowedBackends: ["claude"],
      verifyCommand: "true",
      taskTokenBudget: 100_000,
      taskWallTimeSeconds: 600,
      maxConcurrentTasks: 1,
    }),
  );
}

async function seedTask(repo: CodingRepoRow): Promise<CodingTaskRow> {
  return tx((trx) =>
    store.insertTask(trx, {
      repoId: repo.id,
      goal: "do a thing",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    }),
  );
}

interface FakeContainerOpts {
  exec?: ExecStreamingHandle;
}

interface FakeSandboxResult {
  sandbox: SandboxClient<LocalDockerSessionState>;
  createCalls: {
    taskId: string;
    image: string;
    worktreePath: string | undefined;
    env: Readonly<Record<string, string>> | undefined;
  }[];
  stopCalls: string[];
  /** When non-null, `tryResumeByTaskId` returns a session derived from this state. */
  setExistingSession: (state: LocalDockerSessionState | null) => void;
}

function fakeSandbox(opts: FakeContainerOpts = {}): FakeSandboxResult {
  const createCalls: FakeSandboxResult["createCalls"] = [];
  const stopCalls: string[] = [];

  let lastSessionState: LocalDockerSessionState | null = null;
  let existingSessionState: LocalDockerSessionState | null = null;

  function makeSession(state: LocalDockerSessionState): SandboxSession<LocalDockerSessionState> {
    return {
      state,
      execStreaming: vi.fn(async () => opts.exec ?? noopExec()),
      exec: vi.fn(async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        wallTimeSeconds: 0,
        truncated: false,
      })),
    };
  }

  const sandbox: SandboxClient<LocalDockerSessionState> = {
    backendId: "fake",
    capabilities: {
      siblingContainers: "host-proxy",
      hostBindMount: true,
      customImage: true,
      volumes: "docker",
      workingTreeTransport: "bind-mount",
    },
    healthCheck: async () => ({ ok: true, runtime: "runc" }),
    reconcileCrashedInstances: async () => ({ orphansReaped: 0 }),
    ensureImagePresent: vi.fn(async () => {}),
    create: vi.fn(async (spec) => {
      createCalls.push({
        taskId: spec.taskId,
        image: spec.image,
        worktreePath: spec.worktree?.hostPath,
        env: spec.env,
      });
      // Insert a real `containers` row so coding_tasks.container_id FK is
      // satisfied. Uses the per-test instanceId seeded in beforeEach.
      const row = await tx((trx) =>
        sandboxStore.insertContainer(trx, {
          dockerId: `docker-${Math.random().toString(36).slice(2)}`,
          parentId: null,
          rootTaskId: spec.taskId,
          depth: 0,
          image: spec.image,
          runtime: "runc",
          labels: {
            "cogmo.managed": "true",
            "cogmo.instance": instanceId,
            "cogmo.root_task": spec.taskId,
            "cogmo.parent": "",
            "cogmo.depth": "0",
          },
          resourceLimits: spec.resourceLimits,
          ttlExpiresAt: spec.expiresAt,
          instanceId,
        }),
      );
      lastSessionState = {
        type: "local-docker",
        taskId: spec.taskId,
        containerRowId: row.id,
        dockerId: row.dockerId,
      };
      return makeSession(lastSessionState);
    }),
    resume: vi.fn(async (state) => makeSession(state)),
    tryResumeByTaskId: vi.fn(async (_taskId) => {
      if (existingSessionState) return makeSession(existingSessionState);
      return null;
    }),
    delete: vi.fn(async () => {}),
    deleteByTaskId: vi.fn(async (taskId) => {
      stopCalls.push(taskId);
    }),
    serializeState: (state) => LocalDockerSessionStateSchema.parse(state),
    deserializeState: (payload) => LocalDockerSessionStateSchema.parse(payload),
    shutdown: async () => {},
  };

  return {
    sandbox,
    createCalls,
    stopCalls,
    setExistingSession: (state) => {
      existingSessionState = state;
    },
  };
}

function noopExec(): ExecStreamingHandle {
  return {
    stdout: process.stdin,
    stderr: process.stdin,
    wait: async () => ({ exitCode: 0 }),
    dispose: async () => {},
  };
}

function backendYielding(events: CodingEvent[]): CodingBackend {
  return {
    plan: async function* () {
      for (const ev of events) yield ev;
    },
    execute: async () => {
      throw new Error("execute not exercised by this test — use executeBackendYielding");
    },
  };
}

function executeBackendYielding(
  events: CodingEvent[],
  respondPermission: (
    requestId: string,
    response: { behavior: "allow" | "deny" },
  ) => Promise<void> = async () => {},
): CodingBackend {
  return {
    plan: () => throwingPlan("plan not exercised by this test — use backendYielding"),
    execute: async () => ({
      events: (async function* () {
        for (const ev of events) yield ev;
      })(),
      respondPermission,
    }),
  };
}

// AsyncIterable whose first `next()` throws — used as a stub in tests that
// only exercise `execute`. A generator function (`async function*`) would
// trip biome's `useYield` rule because it has no `yield`, so we hand-roll
// the iterator instead.
function throwingPlan(message: string): AsyncIterable<CodingEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<CodingEvent>> {
        throw new Error(message);
      },
    }),
  };
}

interface RecordingPlanStream {
  text: string[];
  finalized: string[];
  failed: string[];
  handle: import("./orchestrator.js").PlanStreamHandle;
}

function recordingPlanStream(): RecordingPlanStream {
  const out: RecordingPlanStream = {
    text: [],
    finalized: [],
    failed: [],
    handle: undefined!,
  };
  out.handle = {
    appendText: async (delta) => {
      out.text.push(delta);
    },
    finalize: async (plan) => {
      out.finalized.push(plan);
    },
    fail: async (reason) => {
      out.failed.push(reason);
    },
  };
  return out;
}

function makeDeps(
  overrides: Partial<CodingOrchestratorDeps> & {
    sandbox: SandboxClient<LocalDockerSessionState>;
    backend: CodingBackend;
  },
): CodingOrchestratorDeps {
  return {
    runInTx: tx,
    store,
    devbaseImage: "cogmo/devbase:test",
    defaultResourceLimits: RESOURCE_LIMITS,
    taskTtlMs: 60_000,
    worktreesDir: join(baseDir, "worktrees"),
    openPlanStream: async () => NULL_PLAN_STREAM,
    ...overrides,
  };
}

// `inngest` is required by both runCodingTask and runCodingExecute for
// emit-task-failed / emit-cli-done / coding/task/permission-requested.
// Defined here so both describe blocks can share it.
const fakeInngestShared = { send: vi.fn().mockResolvedValue(undefined) };

describe("runCodingTask", () => {
  it("happy path: plan streamed, session_id persisted, status → awaiting_approval (user trigger)", async () => {
    const repo = await seedRepo();
    const task = await seedTask(repo);
    const { sandbox, createCalls, stopCalls } = fakeSandbox();
    const planStream = recordingPlanStream();
    const backend = backendYielding([
      { kind: "session_started", sessionId: "sess-AAA" },
      { kind: "text_delta", text: "## Plan\n" },
      { kind: "text_delta", text: "1. Do X\n" },
      { kind: "plan_ready", plan: "## Plan\n1. Do X\n" },
      { kind: "complete", exitCode: 0, isError: false },
    ]);
    const deps = makeDeps({
      sandbox,
      backend,
      openPlanStream: async () => planStream.handle,
    });

    const result = await runCodingTask({
      taskId: task.id,
      deps,
      stepRun,
      inngest: fakeInngestShared,
    });
    expect(result.status).toBe("awaiting_approval");
    expect(result.plan).toBe("## Plan\n1. Do X\n");

    const reloaded = await tx((trx) => store.getTask(trx, task.id));
    expect(reloaded?.status).toBe("awaiting_approval");
    expect(reloaded?.sessionId).toBe("sess-AAA");
    expect(reloaded?.plan).toBe("## Plan\n1. Do X\n");
    expect(reloaded?.containerId).toBeTruthy();

    expect(createCalls).toHaveLength(1);
    const create0 = createCalls[0];
    if (!create0) throw new Error("expected first create call");
    expect(create0.taskId).toBe(task.id);
    expect(create0.image).toBe("cogmo/devbase:test");
    // Worktree path is derived in the orchestrator's allocate-worktree step:
    // ${worktreesDir}/<repo.name>/<id-short>. Assert the structural contract,
    // not a literal path (the id-short is whatever UUIDv7 the DB generated).
    expect(create0.worktreePath).toContain(`${baseDir}/worktrees/cogmo/`);
    // Persisted worktreeAssignment carries both fields atomically.
    // 12 hex chars, dashes stripped — covers the full 48-bit UUIDv7 timestamp
    // ms portion to avoid prefix collisions on rapid-fire task creation.
    expect(reloaded?.worktreeAssignment?.branch).toMatch(/^cogmo\/[a-f0-9]{12}$/);
    expect(reloaded?.worktreeAssignment?.type).toBe("host-path");
    if (reloaded?.worktreeAssignment?.type === "host-path") {
      expect(reloaded.worktreeAssignment.worktreePath).toBe(create0.worktreePath);
    }

    expect(planStream.text).toEqual(["## Plan\n", "1. Do X\n"]);
    expect(planStream.finalized).toEqual(["## Plan\n1. Do X\n"]);
    expect(planStream.failed).toEqual([]);
    expect(stopCalls).toEqual([]);
    // No secretsStore wired ⇒ no auth env threaded. The supervisor unit
    // test pins what happens with env present; this test pins the absent
    // path so adding a `secretsStore` to the deps interface doesn't
    // silently change the env shape on tests that omit it.
    expect(createCalls[0]?.env).toBeUndefined();
  });

  it("threads CLAUDE_CODE_OAUTH_TOKEN from secretsStore into sandbox.create env", async () => {
    // Pins the contract: when a secretsStore is wired and the OAuth
    // secret is present, it lands on `SessionSpec.env`. See
    // design/coding-delegation.md → Subscription Auth.
    const repo = await seedRepo();
    const task = await seedTask(repo);
    const { sandbox, createCalls } = fakeSandbox();
    const backend = backendYielding([
      { kind: "session_started", sessionId: "sess-AUTH" },
      { kind: "plan_ready", plan: "## Plan\n" },
      { kind: "complete", exitCode: 0, isError: false },
    ]);
    const fakeSecrets = mock<SecretsStore>();
    fakeSecrets.getSecret.mockImplementation(async (_tx, name) =>
      name === "claude_code_oauth_token" ? "sk-test-oauth" : undefined,
    );
    const deps = makeDeps({ sandbox, backend, secretsStore: fakeSecrets });

    const result = await runCodingTask({
      taskId: task.id,
      deps,
      stepRun,
      inngest: fakeInngestShared,
    });
    expect(result.status).toBe("awaiting_approval");
    expect(createCalls[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-test-oauth" });
  });

  it("missing CLAUDE_CODE_OAUTH_TOKEN with secretsStore wired → status=failed before container", async () => {
    const repo = await seedRepo();
    const task = await seedTask(repo);
    const { sandbox, createCalls } = fakeSandbox();
    const backend = backendYielding([]);
    const fakeSecrets = mock<SecretsStore>();
    fakeSecrets.getSecret.mockResolvedValue(undefined);
    const deps = makeDeps({ sandbox, backend, secretsStore: fakeSecrets });

    const result = await runCodingTask({
      taskId: task.id,
      deps,
      stepRun,
      inngest: fakeInngestShared,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureReason).toMatch(/claude_code_oauth_token/);
    }
    expect(createCalls).toHaveLength(0);
  });

  it("automated trigger (evolution) auto-advances to executing", async () => {
    const repo = await seedRepo();
    const task = await tx((trx) =>
      store.insertTask(trx, {
        repoId: repo.id,
        goal: "g",
        triggerSource: "evolution",
        triggerRef: "evo-1",
        backend: "claude",
        allowPrivilegedRunc: false,
      }),
    );
    const { sandbox } = fakeSandbox();
    const backend = backendYielding([
      { kind: "session_started", sessionId: "sess-EVO" },
      { kind: "plan_ready", plan: "auto-plan" },
      { kind: "complete", exitCode: 0, isError: false },
    ]);
    // plan_ready needs a non-empty plan and the orchestrator only emits
    // text_delta into the stream, so plan_ready's plan is what matters.
    const result = await runCodingTask({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      inngest: fakeInngestShared,
    });
    expect(result.status).toBe("executing");
    expect((await tx((trx) => store.getTask(trx, task.id)))?.status).toBe("executing");
  });

  it("backend reports error → status=failed, sandbox stopped, plan stream failed", async () => {
    const repo = await seedRepo();
    const task = await seedTask(repo);
    const { sandbox, stopCalls } = fakeSandbox();
    const planStream = recordingPlanStream();
    const backend = backendYielding([
      { kind: "session_started", sessionId: "sess-X" },
      { kind: "text_delta", text: "partial" },
      { kind: "complete", exitCode: 2, isError: true },
    ]);
    const result = await runCodingTask({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend, openPlanStream: async () => planStream.handle }),
      stepRun,
      inngest: fakeInngestShared,
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/exit code 2/);
    expect((await tx((trx) => store.getTask(trx, task.id)))?.status).toBe("failed");
    expect((await tx((trx) => store.getTask(trx, task.id)))?.failureReason).toMatch(/exit code 2/);
    expect((await tx((trx) => store.getTask(trx, task.id)))?.sessionId).toBe("sess-X");
    expect(stopCalls).toEqual([task.id]);
    expect(planStream.failed).toHaveLength(1);
    expect(planStream.finalized).toEqual([]);
  });

  it("empty plan with success exit → status=failed (treated as nothing-to-show)", async () => {
    const repo = await seedRepo();
    const task = await seedTask(repo);
    const { sandbox, stopCalls } = fakeSandbox();
    const backend = backendYielding([
      { kind: "session_started", sessionId: "sess-E" },
      { kind: "complete", exitCode: 0, isError: false },
    ]);
    const result = await runCodingTask({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      inngest: fakeInngestShared,
    });
    expect(result.status).toBe("failed");
    expect((await tx((trx) => store.getTask(trx, task.id)))?.status).toBe("failed");
    expect(stopCalls).toEqual([task.id]);
  });

  it("createTaskContainer throws → status=failed, deleteByTaskId sweep fires", async () => {
    // The catch path calls `deleteByTaskId(taskId)` unconditionally — on
    // managed backends (Daytona) the SDK's `create()` can throw while
    // provider-side state already exists (e.g. SDK timeout fires while
    // the snapshot build is still running, leaving a labelled sandbox
    // alive on the provider). The unconditional sweep reaps it via the
    // `cogmo.task` label index. On Local-Docker, create commits
    // atomically, so a thrown create leaves no labelled containers and
    // the sweep is a no-op — calling it costs one cheap label query.
    const repo = await seedRepo();
    const task = await seedTask(repo);
    const { sandbox, stopCalls } = fakeSandbox();
    (sandbox.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("docker daemon down"),
    );
    const result = await runCodingTask({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend: backendYielding([]) }),
      stepRun,
      inngest: fakeInngestShared,
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/docker daemon down/);
    expect((await tx((trx) => store.getTask(trx, task.id)))?.status).toBe("failed");
    expect(stopCalls).toEqual([task.id]);
  });

  it("worktree allocation failure → status=failed", async () => {
    // Repo with a non-existent local path so `git worktree add` errors out.
    const badRepo = await tx((trx) =>
      store.insertRepo(trx, {
        name: "bad-path-repo",
        localPath: "/no/such/repo/path",
        defaultBranch: "main",
        remoteUrl: "x",
        devcontainer: null,
        allowedBackends: ["claude"],
        verifyCommand: "true",
        taskTokenBudget: 1,
        taskWallTimeSeconds: 1,
        maxConcurrentTasks: 1,
      }),
    );
    const badTask = await tx((trx) =>
      store.insertTask(trx, {
        repoId: badRepo.id,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      }),
    );

    const { sandbox } = fakeSandbox();
    const result = await runCodingTask({
      taskId: badTask.id,
      deps: makeDeps({ sandbox, backend: backendYielding([]) }),
      stepRun,
      inngest: fakeInngestShared,
    });
    expect(result.status).toBe("failed");
    expect((await tx((trx) => store.getTask(trx, badTask.id)))?.status).toBe("failed");
  });

  it("missing task throws", async () => {
    const { sandbox } = fakeSandbox();
    await expect(
      runCodingTask({
        taskId: "019d0000-0000-7000-8000-0000000000ff",
        deps: makeDeps({ sandbox, backend: backendYielding([]) }),
        stepRun,
        inngest: fakeInngestShared,
      }),
    ).rejects.toThrow(/task not found/);
  });

  it("missing repo throws", async () => {
    const repo = await seedRepo();
    const task = await seedTask(repo);
    // Override the store to return null for getRepoById without violating FK.
    const ghostStore = {
      ...store,
      getTask: store.getTask.bind(store),
      getRepoById: async () => null,
    } as unknown as typeof store;
    const { sandbox } = fakeSandbox();
    await expect(
      runCodingTask({
        taskId: task.id,
        deps: makeDeps({ sandbox, backend: backendYielding([]), store: ghostStore }),
        stepRun,
        inngest: fakeInngestShared,
      }),
    ).rejects.toThrow(/repo not found/);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ──────────────────────────────────────────────────────────────────────
// runCodingExecute — slice 2.0f
// ──────────────────────────────────────────────────────────────────────

interface RecordingExecuteStream {
  text: string[];
  toolCalls: string[];
  toolResults: { tool: string; ok: boolean; summary?: string }[];
  completed: boolean[];
  failed: string[];
  handle: ExecuteStreamHandle;
}

function recordingExecuteStream(): RecordingExecuteStream {
  const out: RecordingExecuteStream = {
    text: [],
    toolCalls: [],
    toolResults: [],
    completed: [],
    failed: [],
    handle: undefined!,
  };
  out.handle = {
    appendText: async (delta) => {
      out.text.push(delta);
    },
    toolCall: async (tool) => {
      out.toolCalls.push(tool);
    },
    toolResult: async (tool, ok, summary) => {
      out.toolResults.push(summary === undefined ? { tool, ok } : { tool, ok, summary });
    },
    complete: async (ok) => {
      out.completed.push(ok);
    },
    fail: async (reason) => {
      out.failed.push(reason);
    },
  };
  return out;
}

/**
 * Bring a freshly inserted task to the post-plan-phase state so
 * runCodingExecute's preconditions are satisfied: status =
 * awaiting_approval, sessionId set, planApprovedAt set, worktreeAssignment
 * set, containerId set (and a real containers row to satisfy the FK).
 */
async function seedExecutableTask(
  repo: CodingRepoRow,
): Promise<{ task: CodingTaskRow; dockerId: string }> {
  const task = await tx((trx) =>
    store.insertTask(trx, {
      repoId: repo.id,
      goal: "execute me",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    }),
  );
  await tx((trx) =>
    store.setTaskWorktreeAssignment(trx, task.id, {
      type: "host-path",
      branch: "cogmo/abc",
      worktreePath: join(baseDir, "worktrees", "cogmo", "abc"),
    }),
  );
  await tx((trx) => store.setTaskSessionId(trx, task.id, "sess-from-plan"));
  // Stamp plan_approved_at via the atomic helper so the test exercises
  // the same path the callback handler uses in production.
  await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "awaiting_approval" }));
  const approval = await tx((trx) => store.approvePlanIfPending(trx, task.id, new Date()));
  expect(approval.kind).toBe("approved");

  // Seed a real containers row + record its dockerId so findLiveContainer
  // discovers something. Not required for the recreate path, but keeps
  // the happy-path test honest about what production does.
  const dockerId = `docker-${Math.random().toString(36).slice(2)}`;
  const containerRow = await tx((trx) =>
    sandboxStore.insertContainer(trx, {
      dockerId,
      parentId: null,
      rootTaskId: task.id,
      depth: 0,
      image: "cogmo/devbase:test-2",
      runtime: "runc",
      labels: {
        "cogmo.managed": "true",
        "cogmo.instance": instanceId,
        "cogmo.root_task": task.id,
        "cogmo.parent": "",
        "cogmo.depth": "0",
      },
      resourceLimits: RESOURCE_LIMITS,
      ttlExpiresAt: new Date(Date.now() + 60_000),
      instanceId,
    }),
  );
  await tx((trx) =>
    sandboxStore.updateContainerStatus(trx, { id: containerRow.id, status: "running" }),
  );
  await tx((trx) => store.setTaskContainerId(trx, task.id, containerRow.id));

  const reloaded = await tx((trx) => store.getTask(trx, task.id));
  if (!reloaded) throw new Error("seedExecutableTask: reload failed");
  return { task: reloaded, dockerId };
}

// Shared fakes for the runCodingExecute tests. The pending_verify path
// emits `coding/task/cli-done` (slice 4.0h handoff) — a no-op send is
// required to avoid the orchestrator throwing on the emit step. The
// tool gate isn't exercised here (no permission_request events in these
// backends), so `stepWaitForEvent` is a stub that never fires.
const fakeStepWaitForEvent = (async () => null) as any;
const fakeInngest = fakeInngestShared;

describe("runCodingExecute", () => {
  it("happy path: container reused, deltas streamed, status → pending_verify, usage persisted", async () => {
    const repo = await seedRepo();
    const { task, dockerId } = await seedExecutableTask(repo);
    const { sandbox, createCalls, stopCalls, setExistingSession } = fakeSandbox();
    // Make `tryResumeByTaskId` return a session — production reuses it
    // instead of creating a new container.
    setExistingSession({
      type: "local-docker",
      taskId: task.id,
      containerRowId: "row-x",
      dockerId,
    });

    const stream = recordingExecuteStream();
    const backend = executeBackendYielding([
      { kind: "session_started", sessionId: "sess-from-plan" },
      { kind: "text_delta", text: "Adding foo()...\n" },
      { kind: "tool_call", tool: "Read", input: { file_path: "foo.ts" } },
      { kind: "tool_result", tool: "Read", ok: true, summary: "export fn" },
      { kind: "tool_call", tool: "Edit", input: {} },
      { kind: "tool_result", tool: "Edit", ok: true },
      {
        kind: "complete",
        exitCode: 0,
        isError: false,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.05 },
      },
    ]);

    const result = await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend, openExecuteStream: async () => stream.handle }),
      stepRun,
      stepWaitForEvent: fakeStepWaitForEvent,
      inngest: fakeInngest,
    });

    expect(result.status).toBe("pending_verify");
    const reloaded = await tx((trx) => store.getTask(trx, task.id));
    expect(reloaded?.status).toBe("pending_verify");
    expect(reloaded?.resourceUsage).toEqual({
      tokens_input: 100,
      tokens_output: 20,
      cost_usd: 0.05,
    });

    // Container reused — no new createTaskContainer call.
    expect(createCalls).toHaveLength(0);
    // Teardown still runs at the grace boundary.
    expect(stopCalls).toEqual([task.id]);

    expect(stream.text).toEqual(["Adding foo()...\n"]);
    expect(stream.toolCalls).toEqual(["Read", "Edit"]);
    expect(stream.toolResults).toEqual([
      { tool: "Read", ok: true, summary: "export fn" },
      { tool: "Edit", ok: true },
    ]);
    expect(stream.completed).toEqual([true]);
    expect(stream.failed).toEqual([]);
  });

  it("recreates container when no live one exists (reaper got it during long approval)", async () => {
    const repo = await seedRepo();
    const { task } = await seedExecutableTask(repo);
    const { sandbox, createCalls, stopCalls } = fakeSandbox();
    // tryResumeByTaskId returns null by default → triggers the recreate branch.

    const stream = recordingExecuteStream();
    const backend = executeBackendYielding([
      { kind: "session_started", sessionId: "sess-from-plan" },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const result = await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend, openExecuteStream: async () => stream.handle }),
      stepRun,
      stepWaitForEvent: fakeStepWaitForEvent,
      inngest: fakeInngest,
    });

    expect(result.status).toBe("pending_verify");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.taskId).toBe(task.id);
    expect(stopCalls).toEqual([task.id]);

    // Phase 3c.5 — fresh-create branch persists raw sandbox lifecycle
    // (backend + start/end ISO timestamps + reserved resources) into
    // `resource_usage.sandbox`. The schema is honest: no computed
    // cpu_seconds, since the Daytona SDK doesn't expose actual usage.
    const reloaded = await tx((trx) => store.getTask(trx, task.id));
    const sb = expectDefined(reloaded?.resourceUsage?.sandbox, "resource_usage.sandbox");
    expect(sb.backend).toBe("fake");
    expect(sb.provisioned).toEqual({
      cpu: RESOURCE_LIMITS.cpus,
      memory_bytes: RESOURCE_LIMITS.memory_bytes,
    });
    // Both timestamps are ISO-8601 datetimes; deleted_at >= created_at.
    const deletedAtIso = expectDefined(sb.deleted_at, "resource_usage.sandbox.deleted_at");
    const createdAt = Date.parse(sb.created_at);
    const deletedAt = Date.parse(deletedAtIso);
    expect(Number.isFinite(createdAt)).toBe(true);
    expect(Number.isFinite(deletedAt)).toBe(true);
    expect(deletedAt).toBeGreaterThanOrEqual(createdAt);
  });

  it("backend reports error → status=failed, sandbox stopped, stream failed (not completed)", async () => {
    const repo = await seedRepo();
    const { task } = await seedExecutableTask(repo);
    const { sandbox, stopCalls } = fakeSandbox();
    const stream = recordingExecuteStream();
    const backend = executeBackendYielding([
      { kind: "session_started", sessionId: "sess-from-plan" },
      { kind: "text_delta", text: "trying...\n" },
      { kind: "complete", exitCode: 2, isError: true },
    ]);

    const result = await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend, openExecuteStream: async () => stream.handle }),
      stepRun,
      stepWaitForEvent: fakeStepWaitForEvent,
      inngest: fakeInngest,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/exit code 2/);
    expect((await tx((trx) => store.getTask(trx, task.id)))?.status).toBe("failed");
    expect(stopCalls).toEqual([task.id]);
    expect(stream.completed).toEqual([false]);
    expect(stream.failed).toHaveLength(1);
  });

  it("idempotent: second event for already-executing task returns skipped without re-running", async () => {
    const repo = await seedRepo();
    const { task } = await seedExecutableTask(repo);
    // Simulate first event already advanced status to executing.
    await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "executing" }));

    const { sandbox } = fakeSandbox();
    const backend = executeBackendYielding([{ kind: "complete", exitCode: 0, isError: false }]);

    const result = await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      stepWaitForEvent: fakeStepWaitForEvent,
      inngest: fakeInngest,
    });

    expect(result.status).toBe("skipped");
    // Status unchanged — second run didn't touch the DB.
    expect((await tx((trx) => store.getTask(trx, task.id)))?.status).toBe("executing");
  });

  it("throws when plan_approved_at is missing (event fired before approve handler stamped it)", async () => {
    const repo = await seedRepo();
    const task = await seedTask(repo);
    await tx((trx) => store.setTaskSessionId(trx, task.id, "sess-x"));
    await tx((trx) =>
      store.setTaskWorktreeAssignment(trx, task.id, {
        type: "host-path",
        branch: "cogmo/x",
        worktreePath: join(baseDir, "wt"),
      }),
    );
    await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "awaiting_approval" }));
    const { sandbox } = fakeSandbox();
    await expect(
      runCodingExecute({
        taskId: task.id,
        deps: makeDeps({
          sandbox,
          backend: executeBackendYielding([]),
          openExecuteStream: async () => NULL_EXECUTE_STREAM,
        }),
        stepRun,
        stepWaitForEvent: fakeStepWaitForEvent,
        inngest: fakeInngest,
      }),
    ).rejects.toThrow(/plan_approved_at/);
  });

  it("throws when session_id is missing (plan phase didn't capture it)", async () => {
    const repo = await seedRepo();
    const task = await seedTask(repo);
    await tx((trx) =>
      store.setTaskWorktreeAssignment(trx, task.id, {
        type: "host-path",
        branch: "cogmo/x",
        worktreePath: join(baseDir, "wt"),
      }),
    );
    await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "awaiting_approval" }));
    await tx((trx) => store.approvePlanIfPending(trx, task.id, new Date()));
    const { sandbox } = fakeSandbox();
    await expect(
      runCodingExecute({
        taskId: task.id,
        deps: makeDeps({ sandbox, backend: executeBackendYielding([]) }),
        stepRun,
        stepWaitForEvent: fakeStepWaitForEvent,
        inngest: fakeInngest,
      }),
    ).rejects.toThrow(/no session_id/);
  });

  it("throws when task not found", async () => {
    const { sandbox } = fakeSandbox();
    await expect(
      runCodingExecute({
        taskId: "019d0000-0000-7000-8000-000000000099",
        deps: makeDeps({ sandbox, backend: executeBackendYielding([]) }),
        stepRun,
        stepWaitForEvent: fakeStepWaitForEvent,
        inngest: fakeInngest,
      }),
    ).rejects.toThrow(/coding task not found/);
  });

  it("resume path bypasses the OAuth check — secret removed post-plan still executes", async () => {
    // Pins the contract that fixes the orphaned-container leak: when an
    // existing container is found, we never recheck the OAuth secret. The
    // env was baked into the container at plan-phase create time and
    // can't be updated retroactively, so a stale or removed secret here
    // is irrelevant. If we DID check, the throw would cause the existing
    // container to be reaped via `deleteByTaskId` and the user would lose
    // the warm session mid-approval.
    const repo = await seedRepo();
    const { task, dockerId } = await seedExecutableTask(repo);
    const { sandbox, createCalls, stopCalls, setExistingSession } = fakeSandbox();
    setExistingSession({
      type: "local-docker",
      taskId: task.id,
      containerRowId: "row-resume",
      dockerId,
    });
    const stream = recordingExecuteStream();
    const backend = executeBackendYielding([
      { kind: "session_started", sessionId: "sess-from-plan" },
      { kind: "complete", exitCode: 0, isError: false },
    ]);
    const fakeSecrets = mock<SecretsStore>();
    fakeSecrets.getSecret.mockResolvedValue(undefined);

    const result = await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({
        sandbox,
        backend,
        openExecuteStream: async () => stream.handle,
        secretsStore: fakeSecrets,
      }),
      stepRun,
      stepWaitForEvent: fakeStepWaitForEvent,
      inngest: fakeInngest,
    });

    expect(result.status).toBe("pending_verify");
    expect(createCalls).toHaveLength(0);
    expect(stopCalls).toEqual([task.id]);
    // OAuth check never ran.
    expect(fakeSecrets.getSecret).not.toHaveBeenCalled();
  });

  it("create branch + missing OAuth → status=failed, no createCalls, deleteByTaskId sweep still fires", async () => {
    // When no container exists (reaper got it during long approval) and
    // the OAuth check fails inside `create-container`, the catch path
    // still fires `deleteByTaskId(taskId)` unconditionally. The sweep is
    // label-indexed and idempotent — if no sandbox was created server-
    // side, the label query returns empty and the call is a no-op. The
    // unconditional call covers the managed-backend case where create()
    // can throw AFTER provider-side state was committed (e.g. Daytona
    // 60s SDK timeout fires while the snapshot build is still running
    // server-side, leaving a labelled sandbox alive).
    const repo = await seedRepo();
    const { task } = await seedExecutableTask(repo);
    const { sandbox, createCalls, stopCalls } = fakeSandbox();
    // tryResumeByTaskId returns null by default → forces create branch.
    const fakeSecrets = mock<SecretsStore>();
    fakeSecrets.getSecret.mockResolvedValue(undefined);

    const result = await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({
        sandbox,
        backend: executeBackendYielding([]),
        secretsStore: fakeSecrets,
      }),
      stepRun,
      stepWaitForEvent: fakeStepWaitForEvent,
      inngest: fakeInngest,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureReason).toMatch(/claude_code_oauth_token/);
    }
    expect(createCalls).toHaveLength(0);
    expect(stopCalls).toEqual([task.id]);
  });
});
