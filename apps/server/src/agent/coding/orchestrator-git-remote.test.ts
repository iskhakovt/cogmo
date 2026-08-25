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

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

interface FakeExecResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function noopExec(result: FakeExecResult = {}): ExecStreamingHandle {
  const out = new PassThrough();
  const err = new PassThrough();
  if (result.stdout) out.write(result.stdout);
  if (result.stderr) err.write(result.stderr);
  out.end();
  err.end();
  return {
    stdout: out as Readable,
    stderr: err as Readable,
    wait: async () => ({ exitCode: result.exitCode ?? 0 }),
    dispose: async () => {},
  };
}

/**
 * Script the fake sandbox's `execStreaming` per-command. The matcher
 * takes the argv (e.g. `["git", "push", "origin", "..."]`) and returns
 * a fake result or `undefined` to fall through to the default
 * `exitCode: 0, no output`. Tests pass a script to drive specific
 * outcomes (e.g. push auth failure) without rebuilding the whole fake.
 */
type ExecScript = (cmd: ReadonlyArray<string>) => FakeExecResult | undefined;

function fakeGitRemoteSandbox(execScript?: ExecScript): FakeGitRemoteSandboxResult {
  const createSpecs: SessionSpec[] = [];
  const execCalls: FakeGitRemoteSandboxResult["execCalls"] = [];

  const session: SandboxSession = {
    state: { type: "daytona", taskId: "t", sandboxId: "sb-fake" },
    execStreaming: vi.fn(async (cmd, opts) => {
      execCalls.push({ cmd, workingDir: opts?.workingDir });
      return noopExec(execScript?.(cmd));
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
      depsCacheSharing: "per-sandbox",
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

/**
 * The git subcommand of an exec, skipping any leading `-c key=value` pairs.
 *
 * Commands Cogmo issues against the task tree carry config on the argv (see
 * `NO_BACKGROUND_MAINTENANCE_FLAGS`), so the subcommand is not at a fixed
 * index and matching on `cmd[1]` silently stops finding anything.
 */
function gitSubcommand(cmd: ReadonlyArray<string>): string | undefined {
  if (cmd[0] !== "git") return undefined;
  let i = 1;
  while (cmd[i] === "-c") i += 2;
  return cmd[i];
}

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
      runId: "run-test",
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
      (c) => gitSubcommand(c.cmd) === "checkout" && c.cmd.includes("-B"),
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
      runId: "run-test",
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
      runId: "run-test",
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
      runId: "run-test",
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
    const checkoutCalls = execCalls.filter((c) => gitSubcommand(c.cmd) === "checkout");
    expect(checkoutCalls).toHaveLength(0);
    // The commit-and-push step MUST still run on the resume path — the
    // askpass mount on the resumed sandbox came from plan-phase
    // provisioning, and execute pushes the run-branch refspec for
    // verify's clone. Default fake exec returns clean status → push
    // takes the no-commit path, but the push call itself is the
    // load-bearing assertion against a regression that skips this step.
    const pushCall = execCalls.find((c) => gitSubcommand(c.cmd) === "push");
    expect(pushCall?.cmd).toContain(`HEAD:refs/heads/cogmo/run/${task.id}`);
  });

  it("wipes the host askpass dir when the plan CLI fails, not just when it throws", async () => {
    // The askpass dir holds the PAT in plaintext and the SSH signing key.
    // `sandbox.deleteByTaskId` does not remove it on a managed backend — only
    // Local-Docker's supervisor does, as a side effect of dropping the bind
    // mount — so the orchestrator has to. The plan-CLI failure path returns
    // from inside the `try`, which skips the catch that used to own this,
    // hence the `finally`.
    const repo = await seedRepo();
    const task = await seedTask(repo);
    const { sandbox } = fakeGitRemoteSandbox();
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockImplementation(async (_tx, name) =>
      name === CLAUDE_CODE_OAUTH_TOKEN_SECRET ? "test-oauth-token" : undefined,
    );

    const result = await runCodingTask({
      taskId: task.id,
      runId: "run-test",
      deps: makeDeps({
        sandbox,
        // Clean failure — `isError`, not a throw, so the catch never runs.
        backend: backendYielding([
          { kind: "session_started", sessionId: "sess-1" },
          { kind: "complete", exitCode: 1, isError: true },
        ]),
        secretsStore,
      }),
      stepRun,
      stepSendEvent,
    });

    expect(result.status).toBe("failed");
    expect(existsSync(join(baseDir, "askpass", task.id))).toBe(false);
  });

  it("fresh-create: provisions askpass, mounts it on the sandbox, and pushes the run-branch", async () => {
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

    // Default fake — no resume hit, falls through to create-container.
    // Simulate one tracked-but-unstaged edit so runCommitAndPush hits
    // the commit + push branch (not nothing_to_commit).
    const { sandbox, createSpecs, execCalls } = fakeGitRemoteSandbox((cmd) => {
      if (gitSubcommand(cmd) === "status" && cmd.includes("--porcelain")) {
        return { exitCode: 0, stdout: "M src/foo.ts\n" };
      }
      return undefined;
    });

    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockImplementation(async (_tx, name) =>
      name === CLAUDE_CODE_OAUTH_TOKEN_SECRET ? "test-oauth-token" : undefined,
    );

    const result = await runCodingExecute({
      taskId: task.id,
      runId: "run-test",
      deps: makeDeps({
        sandbox,
        backend: backendYielding([
          { kind: "session_started", sessionId: "sess-from-plan" },
          { kind: "complete", exitCode: 0, isError: false },
        ]),
        secretsStore,
      }),
      stepRun,
      stepSendEvent,
      inngest: fakeInngest,
    });

    expect(result.status).toBe("pending_verify");

    // Identity loaded for askpass + clone auth.
    expect(transportMocks.loadIdentity).toHaveBeenCalledTimes(1);

    // Fresh-create branch: sandbox.create called with askpass mount.
    expect(createSpecs).toHaveLength(1);
    const spec = createSpecs[0];
    if (!spec) throw new Error("expected one create call");
    expect(spec.askpass?.containerDir).toBe("/tmp/cogmo-askpass");
    expect(spec.askpass?.hostDir).toMatch(new RegExp(`/askpass/${task.id}$`));

    // The execute-side push step ran with `HEAD:refs/heads/<runBranch>`
    // as the push refspec.
    const pushCall = execCalls.find((c) => gitSubcommand(c.cmd) === "push");
    expect(pushCall).toBeDefined();
    expect(pushCall?.cmd).toContain(`HEAD:refs/heads/cogmo/run/${task.id}`);
    expect(pushCall?.workingDir).toBe("/workspace");

    // Commit invocation present + signed with the per-task signing key.
    const commitCall = execCalls.find((c) => gitSubcommand(c.cmd) === "commit");
    expect(commitCall?.cmd).toContain("-S");
    expect(commitCall?.cmd.some((a) => a.startsWith("user.signingkey="))).toBe(true);
  });

  it("push failure: transitions to failed, emits task-failed, skips pending-verify", async () => {
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

    // status shows a tracked edit (so we commit), then push returns a
    // non-zero exit with stderr that runCommitAndPush classifies as
    // auth_failed via its `looksLikeAuthFailure` pattern.
    const { sandbox, execCalls } = fakeGitRemoteSandbox((cmd) => {
      if (gitSubcommand(cmd) === "status" && cmd.includes("--porcelain")) {
        return { exitCode: 0, stdout: "M src/foo.ts\n" };
      }
      if (gitSubcommand(cmd) === "push") {
        return {
          exitCode: 128,
          stderr:
            "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/...'\n",
        };
      }
      return undefined;
    });

    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockImplementation(async (_tx, name) =>
      name === CLAUDE_CODE_OAUTH_TOKEN_SECRET ? "test-oauth-token" : undefined,
    );

    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const inngest = { send: sendSpy };

    const result = await runCodingExecute({
      taskId: task.id,
      runId: "run-test",
      deps: makeDeps({
        sandbox,
        backend: backendYielding([
          { kind: "session_started", sessionId: "sess-from-plan" },
          { kind: "complete", exitCode: 0, isError: false },
        ]),
        secretsStore,
      }),
      stepRun,
      stepSendEvent,
      inngest,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("execute push failed (auth_failed)");

    // Push was attempted before the failure handler kicked in.
    const pushCall = execCalls.find((c) => gitSubcommand(c.cmd) === "push");
    expect(pushCall).toBeDefined();

    // Task row is `failed` with the auth-failure reason, never reached
    // `pending_verify`.
    const reloaded = await tx((trx) => store.getTask(trx, task.id));
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.failureReason).toContain("auth_failed");

    // Sandbox cleanup was invoked through the push-failure path.
    expect(sandbox.deleteByTaskId).toHaveBeenCalledWith(task.id);

    // No cli-done event — pending-verify was skipped, verify orchestrator
    // never gets the handoff.
    const cliDoneSends = sendSpy.mock.calls.filter(
      (c) => (c[0] as { name?: string })?.name === "coding/task/cli-done",
    );
    expect(cliDoneSends).toHaveLength(0);
  });
});
