/**
 * Unit test for `runCodingVerify` — drives the full verify → push → PR
 * sequence with stubbed sandbox + secretsStore. The runners (verify,
 * commit-push, draft-pr) are not mocked; they're invoked with stub
 * containers so we exercise the orchestration in isolation but still
 * catch wiring bugs (env threading, branch flow, status transitions).
 */

import { PassThrough, type Readable } from "node:stream";
import type { Octokit } from "@octokit/rest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import {
  type ExecOptions,
  type ExecStreamingHandle,
  type LocalDockerSessionState,
  LocalDockerSessionStateSchema,
  type SandboxClient,
  type SandboxSession,
} from "../../sandbox/index.js";
import {
  type GitHubIdentity,
  gitHubIdentitySecretName,
  serializeGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { makeStepRun, makeStepSendEvent } from "../../test/factories.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { type CodingBackend, DrizzleCodingStore } from "./store/index.js";
import { runCodingVerify, type VerifyOrchestratorDeps } from "./verify-orchestrator.js";

const stepRun = makeStepRun();

const VALID_IDENTITY: GitHubIdentity = {
  pat: "ghp_dummy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA cogmo-bot",
  login: "cogmo-bot",
  id: "12345",
};

class FakeSecretsStore {
  #values = new Map<string, string>();
  async getSecret(_tx: unknown, name: string): Promise<string | undefined> {
    return this.#values.get(name);
  }
  set(name: string, value: string): void {
    this.#values.set(name, value);
  }
}

interface FakeExecResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function fakeExec(result: FakeExecResult): ExecStreamingHandle {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  stdout.end();
  stderr.end();
  return {
    stdout: stdout as Readable,
    stderr: stderr as Readable,
    wait: vi.fn(async () => ({ exitCode: result.exitCode ?? 0 })),
    dispose: vi.fn(async () => {}),
  };
}

interface FakeContainerScript {
  /** When `bash -lc <verifyCmd>` runs, this is its stdout/exit. */
  verify: FakeExecResult;
  /** Map of `git <subcommand>` -> result. */
  git: Record<string, FakeExecResult>;
}

function fakeContainerHandle(script: FakeContainerScript): SandboxSession<LocalDockerSessionState> {
  const execStreaming = vi.fn(async (cmd: ReadonlyArray<string>, _opts?: ExecOptions) => {
    if (cmd[0] === "bash") return fakeExec(script.verify);
    if (cmd[0] === "git") {
      const sub = cmd.slice(1).find((a) => !a.startsWith("-c") && !a.includes("="));
      if (!sub) throw new Error(`could not parse git subcommand: ${cmd.join(" ")}`);
      const result = script.git[sub];
      if (!result) throw new Error(`no scripted result for git ${sub}`);
      return fakeExec(result);
    }
    throw new Error(`unexpected exec: ${cmd.join(" ")}`);
  });
  return {
    state: {
      type: "local-docker",
      taskId: "t",
      containerRowId: "row-1",
      dockerId: "docker-1",
    },
    execStreaming,
    exec: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      wallTimeSeconds: 0,
      truncated: false,
    })),
  };
}

function fakeSandbox(
  handle: SandboxSession<LocalDockerSessionState>,
): SandboxClient<LocalDockerSessionState> {
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
    healthCheck: vi.fn(),
    reconcileCrashedInstances: vi.fn(),
    ensureImagePresent: vi.fn(async () => {}),
    create: vi.fn(async () => handle),
    resume: vi.fn(async () => handle),
    tryResumeByTaskId: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    deleteByTaskId: vi.fn(async () => {}),
    serializeState: (state) => LocalDockerSessionStateSchema.parse(state),
    deserializeState: (payload) => LocalDockerSessionStateSchema.parse(payload),
    shutdown: vi.fn(),
  };
}

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleCodingStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleCodingStore();
});

afterAll(async () => {
  await close();
});

afterEach(async () => {
  await truncateAll(db);
});

let secrets: FakeSecretsStore;

beforeEach(() => {
  secrets = new FakeSecretsStore();
  secrets.set(gitHubIdentitySecretName("default"), serializeGitHubIdentity(VALID_IDENTITY));
  // Subscription auth: verify-orchestrator now demands the OAuth token
  // before it'll create a container (see auth.ts → loadCodingSandboxEnv).
  secrets.set("claude_code_oauth_token", "sk-test-claude-code-oauth-token");
});

async function seedTask(opts?: {
  remoteUrl?: string;
  status?: "pending_verify" | "queued";
}): Promise<{ taskId: string; repoId: string }> {
  const repo = await tx((trx) =>
    store.insertRepo(trx, {
      name: "fixture",
      localPath: "/tmp/repo",
      defaultBranch: "main",
      remoteUrl: opts?.remoteUrl ?? "https://github.com/user/cogmo.git",
      devcontainer: null,
      allowedBackends: ["claude"] as ReadonlyArray<CodingBackend>,
      verifyCommand: "pnpm test",
      taskTokenBudget: 200_000,
      taskWallTimeSeconds: 1800,
      maxConcurrentTasks: 1,
    }),
  );

  const task = await tx((trx) =>
    store.insertTask(trx, {
      repoId: repo.id,
      goal: "fix the thing",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    }),
  );
  await tx((trx) =>
    store.setTaskWorktreeAssignment(trx, task.id, {
      type: "host-path",
      branch: "cogmo/abc12345",
      worktreePath: "/tmp/worktrees/abc12345",
    }),
  );
  await tx((trx) => store.setTaskPlan(trx, task.id, "1. step\n2. step"));
  if (opts?.status !== "queued") {
    await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "pending_verify" }));
  }
  return { taskId: task.id, repoId: repo.id };
}

function makeDeps(handle: SandboxSession<LocalDockerSessionState>): VerifyOrchestratorDeps {
  return {
    runInTx: tx,
    store,
    sandbox: fakeSandbox(handle),
    secretsStore: secrets as unknown as SecretsStore,
    askpassBaseDir: "/tmp/cogmo-test-askpass",
    devbaseImage: "alpine",
    defaultResourceLimits: { cpus: 1, memory_bytes: 1 << 30, pids: 64 },
    taskTtlMs: 60_000,
  };
}

const successScript: FakeContainerScript = {
  verify: { stdout: "PASS\n", exitCode: 0 },
  git: {
    status: { stdout: "M src/foo.ts\n", exitCode: 0 },
    add: { exitCode: 0 },
    commit: { exitCode: 0 },
    push: { exitCode: 0 },
    "rev-parse": { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n", exitCode: 0 },
  },
};

function fakeOctokitFactory(create: ReturnType<typeof vi.fn>): (pat: string) => Octokit {
  return () => ({ pulls: { create } }) as unknown as Octokit;
}

describe("runCodingVerify", () => {
  it("happy path: verify passes → commit+push → PR opens, status reaches pr_open", async () => {
    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    const create = vi.fn(
      async (_args: {
        owner: string;
        repo: string;
        head: string;
        base: string;
        title: string;
        body: string;
        draft: boolean;
      }) => ({
        data: { html_url: "https://github.com/user/cogmo/pull/42", number: 42 },
      }),
    );
    deps.octokitFactory = fakeOctokitFactory(create);
    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const inngest = { send: inngestSend } as unknown as Pick<import("inngest").Inngest, "send">;

    const { taskId } = await seedTask();
    const result = await runCodingVerify({
      taskId,
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("pr_open");
    if (result.status === "pr_open") {
      expect(result.prUrl).toBe("https://github.com/user/cogmo/pull/42");
      expect(result.prNumber).toBe(42);
    }

    const eventNames = inngestSend.mock.calls.map((c) => c[0].name);
    expect(eventNames).toEqual([
      "coding/task/verify-complete",
      "coding/task/pushed",
      "coding/task/pr-opened",
    ]);

    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).toBe("pr_open");
    expect(reloaded?.prMetadata).toEqual({
      url: "https://github.com/user/cogmo/pull/42",
      number: 42,
      branchSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      openedAt: expect.any(String),
    });

    // Commit step received the canonical noreply author derived from the
    // identity bundle (`<id>+<login>@users.noreply.github.com`).
    const execMock = handle.execStreaming as unknown as ReturnType<typeof vi.fn>;
    const commitCall = execMock.mock.calls.find(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).includes("commit"),
    );
    expect(commitCall).toBeDefined();
    const commitArgs = commitCall?.[0] as string[];
    expect(commitArgs).toContain(`user.email=12345+cogmo-bot@users.noreply.github.com`);
    expect(commitArgs).toContain(`user.name=cogmo-bot`);

    // Octokit was called with the per-task PAT and the parsed owner/repo.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      owner: "user",
      repo: "cogmo",
      head: "cogmo/abc12345",
      base: "main",
      draft: true,
    });
  });

  it("verify failure → status=failed, no commit/push attempted", async () => {
    const handle = fakeContainerHandle({
      verify: { stdout: "FAIL\n  Test failed\n", exitCode: 1 },
      git: {},
    });
    const deps = makeDeps(handle);
    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const inngest = { send: inngestSend } as unknown as Pick<import("inngest").Inngest, "send">;

    const { taskId } = await seedTask();
    const result = await runCodingVerify({
      taskId,
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureReason).toMatch(/verify failed \(exit 1\)/);
      expect(result.failureReason).toMatch(/Test failed/);
    }
    const eventNames = inngestSend.mock.calls.map((c) => c[0].name);
    expect(eventNames).toContain("coding/task/verify-complete");
    expect(eventNames).not.toContain("coding/task/pushed");
    expect(eventNames).not.toContain("coding/task/pr-opened");

    const handleExec = handle.execStreaming as unknown as ReturnType<typeof vi.fn>;
    const calls = handleExec.mock.calls.map((c) => c[0] as ReadonlyArray<string>);
    // Only the verify exec ran; no `git` exec.
    expect(calls.find((c) => c[0] === "git")).toBeUndefined();
  });

  // `failAndTeardown` (the verify-orchestrator's shared failure helper)
  // emits `coding/task/failed` through `stepSendEvent` with the same
  // `task-failed-${taskId}` idempotency id used by `runCodingTask` /
  // `runCodingExecute`. Reconcile-driven re-emits dedupe against it.
  it("try path: failAndTeardown emit carries idempotency id", async () => {
    const handle = fakeContainerHandle({
      verify: { stdout: "FAIL\n  Test failed\n", exitCode: 1 },
      git: {},
    });
    const deps = makeDeps(handle);
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;
    const payloads: unknown[] = [];
    const capturingStepSendEvent = (async (_: string, payload: unknown) => {
      payloads.push(payload);
      return { ids: [] };
    }) as never;

    const { taskId } = await seedTask();
    await runCodingVerify({
      taskId,
      deps,
      stepRun,
      stepSendEvent: capturingStepSendEvent,
      inngest,
    });

    const failed = payloads.find(
      (p): p is { name: string; id: string; data: { taskId: string } } =>
        typeof p === "object" &&
        p !== null &&
        (p as { name?: unknown }).name === "coding/task/failed",
    );
    expect(failed).toBeDefined();
    expect(failed).toMatchObject({
      name: "coding/task/failed",
      id: `task-failed-${taskId}`,
      data: { taskId },
    });
  });

  it("missing identity → status=failed before any container creation", async () => {
    secrets = new FakeSecretsStore(); // no identity set
    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    deps.secretsStore = secrets as unknown as SecretsStore;
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask();
    const result = await runCodingVerify({
      taskId,
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureReason).toMatch(/not configured/i);
    }
    expect(deps.sandbox.create).not.toHaveBeenCalled();
  });

  it("threads CLAUDE_CODE_OAUTH_TOKEN into sandbox.create env", async () => {
    // Pins the wiring contract: the OAuth token from the secrets store
    // lands on `SessionSpec.env` so the supervisor injects it as the
    // container's process env. See design/coding-delegation.md →
    // Subscription Auth.
    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    deps.octokitFactory = fakeOctokitFactory(
      vi.fn(async () => ({
        data: { html_url: "https://github.com/user/cogmo/pull/1", number: 1 },
      })),
    );
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask();
    await runCodingVerify({
      taskId,
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    const createCall = (deps.sandbox.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(createCall?.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-test-claude-code-oauth-token",
    });
  });

  it("missing CLAUDE_CODE_OAUTH_TOKEN → status=failed before container creation", async () => {
    // Removes only the OAuth secret — GitHub identity stays so the
    // identity-resolution gate doesn't short-circuit first. The auth
    // helper's error message must surface as the task's failureReason.
    secrets = new FakeSecretsStore();
    secrets.set(gitHubIdentitySecretName("default"), serializeGitHubIdentity(VALID_IDENTITY));

    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    deps.secretsStore = secrets as unknown as SecretsStore;
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask();
    const result = await runCodingVerify({
      taskId,
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureReason).toMatch(/claude_code_oauth_token/);
    }
    // OAuth check runs as a fail-fast gate alongside identity resolution
    // (see verify-orchestrator.ts), so we never spin up a container or
    // provision askpass on a missing token.
    expect(deps.sandbox.create).not.toHaveBeenCalled();
  });

  it("unparseable remote URL → status=failed", async () => {
    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask({ remoteUrl: "not-a-url" });
    const result = await runCodingVerify({
      taskId,
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureReason).toMatch(/cannot parse owner\/repo/);
    }
    expect(deps.sandbox.create).not.toHaveBeenCalled();
  });

  it("task not in pending_verify → returns skipped without changes", async () => {
    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask({ status: "queued" });
    const result = await runCodingVerify({
      taskId,
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("skipped");
    expect(deps.sandbox.create).not.toHaveBeenCalled();

    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).toBe("queued");
  });

  it("calls stopTask in the finally even when verify fails", async () => {
    const handle = fakeContainerHandle({
      verify: { stdout: "boom\n", exitCode: 1 },
      git: {},
    });
    const deps = makeDeps(handle);
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask();
    await runCodingVerify({
      taskId,
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(deps.sandbox.deleteByTaskId).toHaveBeenCalledWith(taskId);
  });

  // Mirror of the runCodingTask catch-path contract — emit-first
  // ordering pins the reconcile handoff for the verify orchestrator
  // too.
  it("catch path: emit fires BEFORE DB update; emit failure propagates leaving the row non-terminal", async () => {
    // Inject a failure during verify by handing the orchestrator a
    // container whose `bash -lc <verifyCmd>` exec throws (mirrors a
    // sandbox-side failure).
    const handle = fakeContainerHandle(successScript);
    const failingExec = vi.fn(async () => {
      throw new Error("verify exploded");
    });
    const failingHandle: SandboxSession<LocalDockerSessionState> = {
      ...handle,
      execStreaming: failingExec,
    };
    const deps = makeDeps(failingHandle);
    const sendCalls: { eventName: string; whenStatus: string | null }[] = [];
    const stepSendEventThrowing = (async (_: string, payload: unknown) => {
      const row = await tx((trx) => store.getTask(trx, taskId));
      sendCalls.push({
        eventName: (payload as { name: string }).name,
        whenStatus: row?.status ?? null,
      });
      throw new Error("bus down");
    }) as never;
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask();

    await expect(
      runCodingVerify({
        taskId,
        deps,
        stepRun,
        stepSendEvent: stepSendEventThrowing,
        inngest,
      }),
    ).rejects.toThrow(/bus down/);

    // Emit attempted while row was still `verifying` (or its prior
    // state) — the catch fell through to the emit before touching
    // the DB.
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.eventName).toBe("coding/task/failed");
    // Row stays non-terminal for the reconcile subscriber to flip.
    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).not.toBe("failed");
  });
});
