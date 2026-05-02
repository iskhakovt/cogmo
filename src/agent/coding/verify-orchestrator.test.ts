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
import type { Database } from "../../db/index.js";
import type { StepRun } from "../../inngest/index.js";
import type { ExecHandle, ExecOptions, Sandbox, TaskContainerHandle } from "../../sandbox/index.js";
import {
  type GitHubIdentity,
  gitHubIdentitySecretName,
  serializeGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { type CodingBackend, DrizzleCodingStore } from "./store/index.js";
import { runCodingVerify, type VerifyOrchestratorDeps } from "./verify-orchestrator.js";

// biome-ignore lint/suspicious/noExplicitAny: minimal shim mirroring step.run's signature
const stepRun = ((_: string, fn: () => Promise<unknown>) => fn()) as any as StepRun;

const VALID_IDENTITY: GitHubIdentity = {
  pat: "ghp_dummy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA cogmo-bot",
  login: "cogmo-bot",
  id: "12345",
};

class FakeSecretsStore {
  #values = new Map<string, string>();
  async getSecret(name: string): Promise<string | undefined> {
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

function fakeExec(result: FakeExecResult): ExecHandle {
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
  };
}

interface FakeContainerScript {
  /** When `bash -lc <verifyCmd>` runs, this is its stdout/exit. */
  verify: FakeExecResult;
  /** Map of `git <subcommand>` -> result. */
  git: Record<string, FakeExecResult>;
}

function fakeContainerHandle(script: FakeContainerScript): TaskContainerHandle {
  const exec = vi.fn(async (cmd: ReadonlyArray<string>, _opts?: ExecOptions) => {
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
    containerRowId: "row-1",
    dockerId: "docker-1",
    exec,
  };
}

function fakeSandbox(handle: TaskContainerHandle): Sandbox {
  return {
    healthCheck: vi.fn(),
    reconcileCrashedInstances: vi.fn(),
    createTaskContainer: vi.fn(async () => handle),
    getTaskContainer: vi.fn(async () => handle),
    stopTask: vi.fn(async () => {}),
    listContainersForTask: vi.fn(async () => []),
    inspectContainer: vi.fn(),
    shutdown: vi.fn(),
  };
}

let db: Database;
let close: () => Promise<void>;
let store: DrizzleCodingStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  store = new DrizzleCodingStore(db);
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
});

async function seedTask(opts?: {
  remoteUrl?: string;
  status?: "pending_verify" | "queued";
}): Promise<{ taskId: string; repoId: string }> {
  const repo = await store.insertRepo({
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
  });

  const task = await store.insertTask({
    repoId: repo.id,
    goal: "fix the thing",
    triggerSource: "user",
    backend: "claude",
    allowPrivilegedRunc: false,
  });
  await store.setTaskWorktreeAssignment(task.id, {
    branch: "cogmo/abc12345",
    worktreePath: "/tmp/worktrees/abc12345",
  });
  await store.setTaskPlan(task.id, "1. step\n2. step");
  if (opts?.status !== "queued") {
    await store.updateTaskStatus({ id: task.id, status: "pending_verify" });
  }
  return { taskId: task.id, repoId: repo.id };
}

function makeDeps(handle: TaskContainerHandle): VerifyOrchestratorDeps {
  return {
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
    const create = vi.fn(async () => ({
      data: { html_url: "https://github.com/user/cogmo/pull/42", number: 42 },
    }));
    deps.octokitFactory = fakeOctokitFactory(create);
    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const inngest = { send: inngestSend } as unknown as Pick<import("inngest").Inngest, "send">;

    const { taskId } = await seedTask();
    const result = await runCodingVerify({ taskId, deps, stepRun, inngest });

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

    const reloaded = await store.getTask(taskId);
    expect(reloaded?.status).toBe("pr_open");
    expect(reloaded?.prMetadata).toEqual({
      url: "https://github.com/user/cogmo/pull/42",
      number: 42,
      branchSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      openedAt: expect.any(String),
    });

    // Commit step received the canonical noreply author derived from the
    // identity bundle (`<id>+<login>@users.noreply.github.com`).
    const execMock = handle.exec as unknown as ReturnType<typeof vi.fn>;
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
    const result = await runCodingVerify({ taskId, deps, stepRun, inngest });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureReason).toMatch(/verify failed \(exit 1\)/);
      expect(result.failureReason).toMatch(/Test failed/);
    }
    const eventNames = inngestSend.mock.calls.map((c) => c[0].name);
    expect(eventNames).toContain("coding/task/verify-complete");
    expect(eventNames).not.toContain("coding/task/pushed");
    expect(eventNames).not.toContain("coding/task/pr-opened");

    const handleExec = handle.exec as unknown as ReturnType<typeof vi.fn>;
    const calls = handleExec.mock.calls.map((c) => c[0] as ReadonlyArray<string>);
    // Only the verify exec ran; no `git` exec.
    expect(calls.find((c) => c[0] === "git")).toBeUndefined();
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
    const result = await runCodingVerify({ taskId, deps, stepRun, inngest });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureReason).toMatch(/not configured/i);
    }
    expect(deps.sandbox.createTaskContainer).not.toHaveBeenCalled();
  });

  it("unparseable remote URL → status=failed", async () => {
    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask({ remoteUrl: "not-a-url" });
    const result = await runCodingVerify({ taskId, deps, stepRun, inngest });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureReason).toMatch(/cannot parse owner\/repo/);
    }
    expect(deps.sandbox.createTaskContainer).not.toHaveBeenCalled();
  });

  it("task not in pending_verify → returns skipped without changes", async () => {
    const handle = fakeContainerHandle(successScript);
    const deps = makeDeps(handle);
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<
      import("inngest").Inngest,
      "send"
    >;

    const { taskId } = await seedTask({ status: "queued" });
    const result = await runCodingVerify({ taskId, deps, stepRun, inngest });

    expect(result.status).toBe("skipped");
    expect(deps.sandbox.createTaskContainer).not.toHaveBeenCalled();

    const reloaded = await store.getTask(taskId);
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
    await runCodingVerify({ taskId, deps, stepRun, inngest });

    expect(deps.sandbox.stopTask).toHaveBeenCalledWith(taskId);
  });
});
