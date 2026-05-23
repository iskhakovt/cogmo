/**
 * End-to-end orchestrator tests for the git-remote worktree transport
 * (Daytona). The existing `orchestrator.test.ts` exercises the bind-mount
 * path; this file mirrors a happy-path through plan + execute + verify
 * with a fake sandbox whose `workingTreeTransport === "git-remote"`.
 *
 * `git-as-transport` is module-mocked so we don't need a real git remote
 * or askpass helper — the goal is to assert the orchestrator drives the
 * helpers in the right order with the right args, not to re-test the
 * helpers themselves (their unit tests live in `git-as-transport.test.ts`).
 *
 * `worktree.js` is module-mocked too so we can assert `allocateWorktree`
 * is NEVER called on the git-remote path (no host worktree exists).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../../db/index.js";
import type {
  ExecStreamingHandle,
  GitRemoteWorktreeSpec,
  SandboxClient,
  SandboxSession,
  SessionSpec,
} from "../../sandbox/index.js";
import { DrizzleSandboxStore } from "../../sandbox/store/index.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { makeStepRun, nullStepSendEvent } from "../../test/factories.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { CLAUDE_CODE_OAUTH_TOKEN_SECRET } from "./auth.js";
import type { CodingBackend, CodingEvent } from "./backend.js";

// --- Module mocks ---------------------------------------------------------
//
// The orchestrator imports git-as-transport's helpers + worktree's
// allocateWorktree. Mock both at module level so the orchestrator's
// internal calls can be observed and the orchestrator never reaches a
// real git command.

const transportMocks = vi.hoisted(() => ({
  pushTaskBranchToRemote: vi.fn<(p: unknown) => Promise<void>>(),
  fetchFeatureBranch: vi.fn<(p: unknown) => Promise<void>>(),
  loadIdentity: vi.fn<(p: unknown) => Promise<GitHubIdentity>>(),
  runBranchFor: (taskId: string) => `cogmo/run/${taskId}`,
}));

vi.mock("./git-as-transport.js", () => ({
  pushTaskBranchToRemote: transportMocks.pushTaskBranchToRemote,
  fetchFeatureBranch: transportMocks.fetchFeatureBranch,
  loadIdentity: transportMocks.loadIdentity,
  runBranchFor: transportMocks.runBranchFor,
}));

const worktreeMocks = vi.hoisted(() => ({
  allocateWorktree: vi.fn<(p: unknown) => Promise<void>>(),
  removeWorktree: vi.fn<(repo: string, path: string) => Promise<void>>(),
}));

vi.mock("./worktree.js", () => ({
  allocateWorktree: worktreeMocks.allocateWorktree,
  removeWorktree: worktreeMocks.removeWorktree,
}));

// `vi.mock` is hoisted by Vitest, so static imports below see the mocked
// modules. Type imports are erased at compile time and don't trigger
// module loading.
import type { CodingOrchestratorDeps } from "./orchestrator.js";
import {
  NULL_EXECUTE_STREAM,
  NULL_PLAN_STREAM,
  runCodingExecute,
  runCodingTask,
} from "./orchestrator.js";
import { type CodingRepoRow, type CodingTaskRow, DrizzleCodingStore } from "./store/index.js";

// --- Test scaffolding -----------------------------------------------------

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleCodingStore;
let sandboxStore: DrizzleSandboxStore;
let baseDir: string;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleCodingStore();
  sandboxStore = new DrizzleSandboxStore();
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-git-remote-test-"));
  // The test never reads from this dir; it's only for the orchestrator's
  // path-traversal validation when assignments mention worktree paths.
  writeFileSync(join(baseDir, "marker"), "");
});

beforeEach(async () => {
  await tx((trx) => sandboxStore.insertInstance(trx, { host: "test", pid: 1 }));
  transportMocks.pushTaskBranchToRemote.mockReset();
  transportMocks.fetchFeatureBranch.mockReset();
  transportMocks.loadIdentity.mockReset();
  worktreeMocks.allocateWorktree.mockReset();
  worktreeMocks.removeWorktree.mockReset();

  transportMocks.loadIdentity.mockResolvedValue({
    pat: "ghp_test",
    sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
    sshPublicKey: "ssh-ed25519 AAAA",
    login: "cogmo-bot",
    id: "12345",
  });
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  rmSync(baseDir, { recursive: true, force: true });
  await close();
});

const stepRun = makeStepRun();
const stepSendEvent = nullStepSendEvent();
const RESOURCE_LIMITS = { cpus: 0.5, memory_bytes: 256 * 1024 * 1024, pids: 64 };
const fakeInngest = { send: vi.fn().mockResolvedValue(undefined) };

async function seedRepo(): Promise<CodingRepoRow> {
  return tx((trx) =>
    store.insertRepo(trx, {
      name: "cogmo",
      localPath: join(baseDir, "repo"),
      defaultBranch: "main",
      remoteUrl: "https://github.com/owner/cogmo.git",
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

// --- Fake git-remote sandbox ---------------------------------------------

interface FakeGitRemoteSandboxResult {
  sandbox: SandboxClient;
  createSpecs: SessionSpec[];
  execCalls: Array<{ cmd: ReadonlyArray<string>; workingDir: string | undefined }>;
}

function noopExec(stdout = "", stderr = ""): ExecStreamingHandle {
  const out = new PassThrough();
  const err = new PassThrough();
  if (stdout) out.write(stdout);
  if (stderr) err.write(stderr);
  out.end();
  err.end();
  return {
    stdout: out as Readable,
    stderr: err as Readable,
    wait: async () => ({ exitCode: 0 }),
    dispose: async () => {},
  };
}

function fakeGitRemoteSandbox(): FakeGitRemoteSandboxResult {
  const createSpecs: SessionSpec[] = [];
  const execCalls: FakeGitRemoteSandboxResult["execCalls"] = [];

  const session: SandboxSession = {
    state: { type: "daytona", taskId: "t", sandboxId: "sb-fake" },
    execStreaming: vi.fn(async (cmd, opts) => {
      execCalls.push({ cmd, workingDir: opts?.workingDir });
      return noopExec();
    }),
    exec: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      wallTimeSeconds: 0,
      truncated: false,
    })),
  };

  const sandbox: SandboxClient = {
    backendId: "fake-daytona",
    capabilities: {
      siblingContainers: "sandbox-internal",
      hostBindMount: false,
      customImage: true,
      volumes: "managed",
      workingTreeTransport: "git-remote",
    },
    healthCheck: async () => ({ ok: true, runtime: "daytona" }),
    reconcileCrashedInstances: async () => ({ orphansReaped: 0 }),
    ensureImagePresent: vi.fn(async () => {}),
    create: vi.fn(async (spec) => {
      createSpecs.push(spec);
      return session;
    }),
    resume: vi.fn(async () => session),
    tryResumeByTaskId: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    deleteByTaskId: vi.fn(async () => {}),
    serializeState: (state) => state as unknown as Record<string, unknown>,
    deserializeState: (payload) => payload as never,
    shutdown: async () => {},
  };
  return { sandbox, createSpecs, execCalls };
}

function backendYielding(events: CodingEvent[]): CodingBackend {
  return {
    plan: async function* () {
      for (const ev of events) yield ev;
    },
    execute: async function* () {
      for (const ev of events) yield ev;
    },
  };
}

function makeDeps(
  overrides: Partial<CodingOrchestratorDeps> & {
    sandbox: SandboxClient;
    backend: CodingBackend;
    secretsStore: SecretsStore;
  },
): CodingOrchestratorDeps {
  return {
    runInTx: tx,
    store,
    devbaseImage: "ghcr.io/iskhakovt/cogmo-devbase:test",
    defaultResourceLimits: RESOURCE_LIMITS,
    taskTtlMs: 60_000,
    worktreesDir: join(baseDir, "worktrees"),
    askpassBaseDir: join(baseDir, "askpass"),
    openPlanStream: async () => NULL_PLAN_STREAM,
    openExecuteStream: async () => NULL_EXECUTE_STREAM,
    ...overrides,
  };
}

// --- Tests ---------------------------------------------------------------

describe("runCodingTask — git-remote transport", () => {
  it("happy path: pushes run-branch, clones via WorktreeSpec.git-remote, checks out feature branch", async () => {
    const repo = await seedRepo();
    const task = await seedTask(repo);
    const { sandbox, createSpecs, execCalls } = fakeGitRemoteSandbox();
    const secretsStore = mock<SecretsStore>();
    // `loadCodingSandboxEnv` short-circuits the create-container step
    // unless this secret is present.
    secretsStore.getSecret.mockImplementation(async (_tx, name) =>
      name === CLAUDE_CODE_OAUTH_TOKEN_SECRET ? "test-oauth-token" : undefined,
    );

    const result = await runCodingTask({
      taskId: task.id,
      deps: makeDeps({
        sandbox,
        backend: backendYielding([
          { kind: "session_started", sessionId: "sess-1" },
          { kind: "plan_ready", plan: "## Plan\n1. Edit foo\n" },
          { kind: "complete", exitCode: 0, isError: false },
        ]),
        secretsStore,
      }),
      stepRun,
      stepSendEvent,
    });

    expect(result.status).toBe("awaiting_approval");

    // (1) host-side allocateWorktree NEVER called — git-remote has no
    // host worktree, only an in-sandbox checkout.
    expect(worktreeMocks.allocateWorktree).not.toHaveBeenCalled();

    // (2) loadIdentity called twice (once in allocate-worktree to push,
    // once in create-container for clone auth).
    expect(transportMocks.loadIdentity).toHaveBeenCalledTimes(2);
    expect(transportMocks.loadIdentity.mock.calls[0]?.[0]).toMatchObject({
      identityName: "default",
    });

    // (3) pushTaskBranchToRemote called with the run-branch refspec.
    expect(transportMocks.pushTaskBranchToRemote).toHaveBeenCalledTimes(1);
    expect(transportMocks.pushTaskBranchToRemote.mock.calls[0]?.[0]).toMatchObject({
      localRepoPath: repo.localPath,
      remoteUrl: repo.remoteUrl,
      taskId: task.id,
      defaultBranch: "main",
    });

    // (4) sandbox.create received WorktreeSpec.git-remote pointing at
    // cogmo/run/<task-id>, NOT a host-path spec.
    expect(createSpecs).toHaveLength(1);
    const spec = createSpecs[0];
    if (!spec) throw new Error("expected one create call");
    expect(spec.worktree?.type).toBe("git-remote");
    const gitRemote = spec.worktree as GitRemoteWorktreeSpec;
    expect(gitRemote.url).toBe(repo.remoteUrl);
    expect(gitRemote.branch).toBe(`cogmo/run/${task.id}`);
    expect(gitRemote.auth).toEqual({ username: "x-access-token", password: "ghp_test" });

    // (5) git-remote backends MUST NOT receive homeVolume — Daytona
    // auto-persists FS across stop/start and would reject the option.
    expect(spec.homeVolume).toBeUndefined();

    // (6) post-create `git checkout -B cogmo/<idShort>` exec captured.
    const idShort = task.id.replaceAll("-", "").slice(0, 12);
    const checkoutCall = execCalls.find(
      (c) => c.cmd[0] === "git" && c.cmd[1] === "checkout" && c.cmd[2] === "-B",
    );
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall?.cmd).toEqual(["git", "checkout", "-B", `cogmo/${idShort}`]);
    expect(checkoutCall?.workingDir).toBe("/workspace");

    // (7) Persisted assignment is the git-remote variant — no
    // `worktreePath` field.
    const reloaded = await tx((trx) => store.getTask(trx, task.id));
    expect(reloaded?.worktreeAssignment?.type).toBe("git-remote");
    expect(reloaded?.worktreeAssignment?.branch).toBe(`cogmo/${idShort}`);
  });

  it("fails fast when secretsStore is missing (git-remote requires identity for push auth)", async () => {
    const repo = await seedRepo();
    const task = await seedTask(repo);
    const { sandbox } = fakeGitRemoteSandbox();

    const result = await runCodingTask({
      taskId: task.id,
      deps: makeDeps({
        sandbox,
        backend: backendYielding([]),
        // @ts-expect-error — deliberately undefined to exercise the secretsStore guard
        secretsStore: undefined,
      }),
      stepRun,
      stepSendEvent,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("secretsStore");
    // Push and clone never happened — fast-fail before any side effect.
    expect(transportMocks.pushTaskBranchToRemote).not.toHaveBeenCalled();
  });

  it("rolls back the run-branch push on resume — assignment already persisted, push still re-fires", async () => {
    // Inngest replay scenario: a prior plan-phase attempt persisted the
    // assignment but crashed before pushing. The retry should re-derive
    // the same branch, re-push (force-push semantics), and the row
    // already-set is detected so we don't overwrite.
    const repo = await seedRepo();
    const task = await seedTask(repo);
    const idShort = task.id.replaceAll("-", "").slice(0, 12);
    // Pre-populate the assignment as if a prior attempt got there.
    await tx((trx) =>
      store.setTaskWorktreeAssignment(trx, task.id, {
        type: "git-remote",
        branch: `cogmo/${idShort}`,
      }),
    );

    const { sandbox } = fakeGitRemoteSandbox();
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockImplementation(async (_tx, name) =>
      name === CLAUDE_CODE_OAUTH_TOKEN_SECRET ? "test-oauth-token" : undefined,
    );

    const result = await runCodingTask({
      taskId: task.id,
      deps: makeDeps({
        sandbox,
        backend: backendYielding([
          { kind: "session_started", sessionId: "sess-1" },
          { kind: "plan_ready", plan: "## Plan\n" },
          { kind: "complete", exitCode: 0, isError: false },
        ]),
        secretsStore,
      }),
      stepRun,
      stepSendEvent,
    });

    expect(result.status).toBe("awaiting_approval");
    // pushTaskBranchToRemote runs every time — its force-push semantics
    // make resume safe.
    expect(transportMocks.pushTaskBranchToRemote).toHaveBeenCalledTimes(1);
  });
});

describe("runCodingExecute — git-remote transport", () => {
  it("happy path: tryResumeByTaskId hit → no fresh clone, no checkout (sandbox already on feature branch)", async () => {
    const repo = await seedRepo();
    const task = await seedTask(repo);
    const idShort = task.id.replaceAll("-", "").slice(0, 12);
    await tx((trx) =>
      store.setTaskWorktreeAssignment(trx, task.id, {
        type: "git-remote",
        branch: `cogmo/${idShort}`,
      }),
    );
    await tx((trx) => store.setTaskSessionId(trx, task.id, "sess-from-plan"));
    await tx((trx) =>
      store.updateTaskStatus(trx, {
        id: task.id,
        status: "awaiting_approval",
        planApprovedAt: new Date(),
      }),
    );

    const { sandbox, createSpecs, execCalls } = fakeGitRemoteSandbox();
    // Resume hit — tryResumeByTaskId returns the existing session
    // instead of null.
    sandbox.tryResumeByTaskId = vi.fn(async () => ({
      state: { type: "daytona", taskId: task.id, sandboxId: "sb-existing" },
      execStreaming: vi.fn(async () => noopExec()),
      exec: vi.fn(),
    })) as unknown as typeof sandbox.tryResumeByTaskId;

    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockImplementation(async (_tx, name) =>
      name === CLAUDE_CODE_OAUTH_TOKEN_SECRET ? "test-oauth-token" : undefined,
    );

    const result = await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({
        sandbox,
        backend: backendYielding([
          { kind: "session_started", sessionId: "sess-from-plan" },
          {
            kind: "complete",
            exitCode: 0,
            isError: false,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        ]),
        secretsStore,
      }),
      stepRun,
      stepSendEvent,
      inngest: fakeInngest,
    });

    expect(result.status).toBe("pending_verify");
    // Resume path: no fresh clone, so create wasn't called.
    expect(createSpecs).toHaveLength(0);
    // Resume path: no fresh checkout-B either — the existing sandbox
    // is already on the feature branch from the prior attempt.
    const checkoutCalls = execCalls.filter((c) => c.cmd[0] === "git" && c.cmd[1] === "checkout");
    expect(checkoutCalls).toHaveLength(0);
  });
});
