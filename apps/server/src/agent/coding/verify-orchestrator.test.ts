/**
 * Unit test for `runCodingVerify` — drives the full verify → push → PR
 * sequence with stubbed sandbox + secretsStore. The runners (verify,
 * commit-push, open-pr) are not mocked; they're invoked with stub
 * containers so we exercise the orchestration in isolation but still
 * catch wiring bugs (env threading, branch flow, status transitions).
 */

import { RequestError } from "@octokit/request-error";
import type { Octokit } from "@octokit/rest";
import type { Inngest } from "inngest";
import { err } from "neverthrow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
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
import { expectOk } from "../../test/assertions.js";
import { fakeExecHandle, parkCodingTaskAt } from "../../test/coding-fixtures.js";
import { makeStepRun, makeStepSendEvent, recordingStepRun } from "../../test/factories.js";
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
  /** The transport fails: both streams fail with this error, and so does the exec. */
  transportError?: Error;
  /** The exec's outcome, when it is not a plain exit. */
  exited?: ExecStreamingHandle["exited"];
}

function fakeExec(result: FakeExecResult): ExecStreamingHandle {
  return fakeExecHandle({ ...result, dispose: vi.fn(async () => {}) });
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
  /** Where the row is parked once allocated; `pending_verify` unless given. */
  status?: "pending_verify" | "awaiting_approval";
}): Promise<{ taskId: string; repoId: string }> {
  const repo = await tx((trx) =>
    store
      .insertRepo(trx, {
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
      })
      .then(expectOk),
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
  // The plan run allocates after its claim (`chk_coding_tasks_queued_bare`).
  await parkCodingTaskAt(tx, store, task.id, "planning");
  await tx((trx) =>
    store.setTaskWorktreeAssignment(trx, task.id, {
      type: "host-path",
      branch: "cogmo/abc12345",
      worktreePath: "/tmp/worktrees/abc12345",
    }),
  );
  await tx((trx) => store.setTaskPlan(trx, task.id, "1. step\n2. step"));
  await parkCodingTaskAt(tx, store, task.id, opts?.status ?? "pending_verify");
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
      runId: "run-test",
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
    });
    // Ready-for-review PR — no draft flag in the request.
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("draft");
  });

  it("a transport failure reading HEAD on a clean tree fails the task without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const handle = fakeContainerHandle({
        verify: { stdout: "PASS\n", exitCode: 0 },
        git: {
          status: { stdout: "", exitCode: 0 },
          "rev-parse": { transportError: new Error("hijacked socket reset") },
        },
      });
      const deps = makeDeps(handle);
      const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
        import("inngest").Inngest,
        "send"
      >;
      const { taskId } = await seedTask();
      const result = await runCodingVerify({
        taskId,
        runId: "run-test",
        deps,
        stepRun,
        stepSendEvent: makeStepSendEvent(inngest),
        inngest,
      });

      expect(result.status).toBe("failed");
      // Node reports an unhandled rejection once the microtask queue drains.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("verify hitting its cap → failed as verify_timed_out", async () => {
    const handle = fakeContainerHandle({
      verify: {
        stdout: "running…\n",
        exited: Promise.resolve(err({ kind: "timed_out", deadline: "total", timeoutMs: 1_000 })),
      },
      git: {},
    });
    const deps = makeDeps(handle);
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask();
    const result = await runCodingVerify({
      taskId,
      runId: "run-test",
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("failed");
    expect(result.failure?.reason).toBe("verify_timed_out");
    expect(result.failure?.detail).toMatch(/^exit 124\n/);
    expect(result.failure?.detail).toMatch(/verify timed out/);
    expect((await tx((trx) => store.getTask(trx, taskId)))?.failureReason).toBe("verify_timed_out");
  });

  it.each([
    [
      "auth_failed",
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/u/c/'\n",
    ],
    ["branch_conflict", "! [rejected]        cogmo/abc12345 -> cogmo/abc12345 (fetch first)\n"],
    ["push_failed", "fatal: unable to access 'https://github.com/u/c/': Could not resolve host\n"],
  ] as const)(
    "a push the remote rejects → failed as %s with the push output",
    async (reason, stderr) => {
      const handle = fakeContainerHandle({
        ...successScript,
        git: { ...successScript.git, push: { exitCode: 128, stderr } },
      });
      const deps = makeDeps(handle);
      const create = vi.fn();
      deps.octokitFactory = fakeOctokitFactory(create);
      const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
        import("inngest").Inngest,
        "send"
      >;

      const { taskId } = await seedTask();
      const result = await runCodingVerify({
        taskId,
        runId: "run-test",
        deps,
        stepRun,
        stepSendEvent: makeStepSendEvent(inngest),
        inngest,
      });

      expect(result.status).toBe("failed");
      expect(result.failure?.reason).toBe(reason);
      expect(result.failure?.detail).toContain(stderr.trim());
      expect(create).not.toHaveBeenCalled();
      const reloaded = await tx((trx) => store.getTask(trx, taskId));
      expect(reloaded?.status).toBe("failed");
      expect(reloaded?.failureReason).toBe(reason);
    },
  );

  it.each([
    [401, "pr_auth_failed", "Bad credentials"],
    [422, "pr_validation_failed", "A pull request already exists for cogmo/abc12345."],
    [502, "pr_open_failed", "Server Error"],
  ] as const)("a PR open GitHub answers %s → failed as %s", async (status, reason, message) => {
    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    const create = vi.fn(async () => {
      throw new RequestError(message, status, {
        request: { method: "POST", url: "https://api.github.com/repos/u/c/pulls", headers: {} },
      });
    });
    deps.octokitFactory = fakeOctokitFactory(create);
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask();
    const result = await runCodingVerify({
      taskId,
      runId: "run-test",
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("failed");
    expect(result.failure?.reason).toBe(reason);
    expect(result.failure?.detail).toContain(message);
    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.failureReason).toBe(reason);
    expect(reloaded?.prMetadata).toBeNull();
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
      runId: "run-test",
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure?.reason).toBe("verify_failed");
      expect(result.failure?.detail).toMatch(/^exit 1\n/);
      expect(result.failure?.detail).toMatch(/Test failed/);
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
      runId: "run-test",
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
      runId: "run-test",
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure?.reason).toBe("credentials_unavailable");
      expect(result.failure?.detail).toMatch(/not configured/i);
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
      runId: "run-test",
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
      runId: "run-test",
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure?.reason).toBe("credentials_unavailable");
      expect(result.failure?.detail).toMatch(/claude_code_oauth_token/);
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
      runId: "run-test",
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure?.reason).toBe("credentials_unavailable");
      expect(result.failure?.detail).toMatch(/cannot parse owner\/repo/);
    }
    expect(deps.sandbox.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a failure the run observes",
      async () =>
        (await seedTask({ remoteUrl: "https://x-access-token:SECRET@github.com" })).taskId,
      (handle: SandboxSession<LocalDockerSessionState>) => handle,
      "credentials_unavailable",
      "cannot parse owner/repo from remote URL: https://REDACTED@github.com",
    ],
    [
      "a failure that reaches the catch",
      async () => (await seedTask()).taskId,
      (
        handle: SandboxSession<LocalDockerSessionState>,
      ): SandboxSession<LocalDockerSessionState> => ({
        ...handle,
        execStreaming: vi.fn(async () => {
          throw new Error("exec via ssh://git:SECRET@sandbox.internal/x failed");
        }),
      }),
      "unexpected_error",
      "exec via ssh://REDACTED@sandbox.internal/x failed",
    ],
  ])(
    "%s: the return value, row and event carry one masked reason",
    async (_label, seed, wrap, reason, masked) => {
      const deps = makeDeps(wrap(fakeContainerHandle(successScript)));
      const inngest = mock<Pick<Inngest, "send">>();
      inngest.send.mockResolvedValue({ ids: [] });
      const taskId = await seed();

      const result = await runCodingVerify({
        taskId,
        runId: "run-test",
        deps,
        stepRun,
        stepSendEvent: makeStepSendEvent(inngest),
        inngest,
      });

      const failure = { reason, detail: masked };
      expect(result).toEqual({ status: "failed", failure });
      expect((await tx((trx) => store.getTask(trx, taskId)))?.failureDetail).toBe(masked);
      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({ name: "coding/task/failed", data: { taskId, ...failure } }),
      );
    },
  );

  it("a Cancel during the suite stands: no pushed event, no PR, worktree reclaimed", async () => {
    const { taskId } = await seedTask();
    const scripted = fakeContainerHandle(successScript);
    // The Cancel lands while `run-verify` is still executing the suite.
    const handle: SandboxSession<LocalDockerSessionState> = {
      ...scripted,
      execStreaming: async (cmd, opts) => {
        if (cmd[0] === "bash") {
          await tx((trx) => store.cancelTaskIfActive(trx, taskId, "user_cancelled"));
        }
        return scripted.execStreaming(cmd, opts);
      },
    };
    const deps = makeDeps(handle);
    const create = vi.fn(async () => ({
      data: { html_url: "https://github.com/user/cogmo/pull/42", number: 42 },
    }));
    deps.octokitFactory = fakeOctokitFactory(create);
    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const inngest = { send: inngestSend } as unknown as Pick<import("inngest").Inngest, "send">;
    const steps = recordingStepRun();

    const result = await runCodingVerify({
      taskId,
      runId: "run-test",
      deps,
      stepRun: steps.stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result).toEqual({ status: "skipped" });
    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).toBe("cancelled");
    expect(reloaded?.failureReason).toBe("user_cancelled");
    expect(reloaded?.prMetadata).toBeNull();
    const eventNames = inngestSend.mock.calls.map((c) => c[0].name);
    expect(eventNames).toEqual(["coding/task/verify-complete"]);
    expect(create).not.toHaveBeenCalled();
    // The cancelled path's own reclaim, not just the `finally`'s sweep.
    expect(steps.ids).toContain("teardown-worktree-cancelled");
    expect(steps.ids).not.toContain("emit-pushed");
    expect(deps.sandbox.deleteByTaskId).toHaveBeenCalledWith(taskId);
  });

  it("a Cancel during the suite, then the suite fails: stays cancelled, no failure recorded", async () => {
    const { taskId } = await seedTask();
    const scripted = fakeContainerHandle({
      verify: { stdout: "FAIL\n", exitCode: 1 },
      git: {},
    });
    const handle: SandboxSession<LocalDockerSessionState> = {
      ...scripted,
      execStreaming: async (cmd, opts) => {
        if (cmd[0] === "bash") {
          await tx((trx) => store.cancelTaskIfActive(trx, taskId, "user_cancelled"));
        }
        return scripted.execStreaming(cmd, opts);
      },
    };
    const deps = makeDeps(handle);
    const sent: { name: string }[] = [];
    const stepSendEvent = (async (_: string, payload: { name: string }) => {
      sent.push(payload);
      return { ids: [] };
    }) as never;
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;
    const steps = recordingStepRun();

    const result = await runCodingVerify({
      taskId,
      runId: "run-test",
      deps,
      stepRun: steps.stepRun,
      stepSendEvent,
      inngest,
    });

    expect(result).toEqual({ status: "skipped" });
    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).toBe("cancelled");
    expect(reloaded?.failureReason).toBe("user_cancelled");
    expect(sent).toEqual([]);
    expect(steps.ids).toContain("transition-failed");
    expect(steps.ids).toContain("teardown-worktree-cancelled");
    expect(steps.ids).not.toContain("teardown-worktree");
  });

  it("a Cancel during the PR open stands: pr_metadata records the PR, no pr-opened event", async () => {
    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    const { taskId } = await seedTask();
    // The Cancel lands while `open-pr` is waiting on GitHub, which has
    // already opened the PR by the time the step returns.
    const create = vi.fn(async () => {
      await tx((trx) => store.cancelTaskIfActive(trx, taskId, "user_cancelled"));
      return { data: { html_url: "https://github.com/user/cogmo/pull/42", number: 42 } };
    });
    deps.octokitFactory = fakeOctokitFactory(create);
    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const inngest = { send: inngestSend } as unknown as Pick<import("inngest").Inngest, "send">;
    const steps = recordingStepRun();

    const result = await runCodingVerify({
      taskId,
      runId: "run-test",
      deps,
      stepRun: steps.stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result).toEqual({ status: "skipped" });
    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).toBe("cancelled");
    expect(reloaded?.prMetadata).toMatchObject({
      url: "https://github.com/user/cogmo/pull/42",
      number: 42,
    });
    const eventNames = inngestSend.mock.calls.map((c) => c[0].name);
    expect(eventNames).toEqual(["coding/task/verify-complete", "coding/task/pushed"]);
    expect(steps.ids).toContain("teardown-worktree-cancelled");
    expect(steps.ids).not.toContain("emit-pr-opened");
    expect(deps.sandbox.deleteByTaskId).toHaveBeenCalledWith(taskId);
  });

  it("task not in pending_verify → returns skipped without changes", async () => {
    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask({ status: "awaiting_approval" });
    const result = await runCodingVerify({
      taskId,
      runId: "run-test",
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result.status).toBe("skipped");
    expect(deps.sandbox.create).not.toHaveBeenCalled();

    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).toBe("awaiting_approval");
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
      runId: "run-test",
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(deps.sandbox.deleteByTaskId).toHaveBeenCalledWith(taskId);
  });

  // Mirror of the runCodingTask catch-path contract — write, then
  // emit — for the verify orchestrator.
  it("catch path: the write commits before the emit; an emit failure propagates with the row failed", async () => {
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
        runId: "run-test",
        deps,
        stepRun,
        stepSendEvent: stepSendEventThrowing,
        inngest,
      }),
    ).rejects.toThrow(/bus down/);

    // The conditional write landed first; the emit then failed the run,
    // leaving the task `failed` and unannounced.
    expect(sendCalls).toEqual([{ eventName: "coding/task/failed", whenStatus: "failed" }]);
    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.failureReason).toBe("unexpected_error");
  });

  it("a throw after the PR opened leaves the task pr_open: no failure written, none announced", async () => {
    // `emit-pr-opened` exhausting its retries reaches the catch with the row
    // already at `pr_open`; the catch's write is conditional, so it stands.
    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    deps.octokitFactory = fakeOctokitFactory(
      vi.fn(async () => ({
        data: { html_url: "https://github.com/user/cogmo/pull/42", number: 42 },
      })),
    );
    const inngestSend = vi.fn(async (payload: { name: string }) => {
      if (payload.name === "coding/task/pr-opened") throw new Error("bus down");
      return undefined;
    });
    const inngest = { send: inngestSend } as unknown as Pick<import("inngest").Inngest, "send">;

    const { taskId } = await seedTask();
    const result = await runCodingVerify({
      taskId,
      runId: "run-test",
      deps,
      stepRun,
      stepSendEvent: makeStepSendEvent(inngest),
      inngest,
    });

    expect(result).toEqual({ status: "skipped" });
    const sent = inngestSend.mock.calls.map((c) => c[0].name);
    expect(sent).toContain("coding/task/pr-opened");
    expect(sent).not.toContain("coding/task/failed");
    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).toBe("pr_open");
    expect(reloaded?.failureReason).toBeNull();
  });
});
