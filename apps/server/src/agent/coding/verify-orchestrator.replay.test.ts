/**
 * Inngest replay tests for the verify → push → PR orchestrator
 * (`coding-task-verify`).
 *
 * Driven through `@inngest/test`, whose engine reproduces Inngest's
 * per-boundary model: the whole function body is re-invoked once per step
 * boundary with earlier steps served from cache. That is the shape of a
 * clean production run, not a retry simulation.
 *
 * What these tests pin:
 *   1. The verify command — the repo's entire test suite — runs once per
 *      task, not once per remaining boundary.
 *   2. `git push` happens once, and `pulls.create` happens once. A second
 *      PR POST comes back 422 `validation_failed`, which this function
 *      reads as a failure, so re-running it would let the run that had just
 *      opened the PR mark its own task `failed`.
 *   3. The run does not short-circuit on the `verifying` status its own
 *      `set-status-verifying` step wrote.
 *   4. A genuinely duplicate event still skips, and skips before touching
 *      the failure machinery.
 *
 * See .claude/rules/inngest.md and design/crash-recovery.md.
 */

import { PassThrough, type Readable } from "node:stream";
import { InngestTestEngine } from "@inngest/test";
import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../../inngest/client.js";
import {
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
import { fakeRunInTx, spyOnInngestSend } from "../../test/factories.js";
import type { CodingRepoRow, CodingStore, CodingTaskRow } from "./store/index.js";
import {
  createCodingVerifyOrchestrator,
  type VerifyOrchestratorDeps,
} from "./verify-orchestrator.js";

const TASK_ID = "01a02000-0000-7000-8000-00000000ta5c";
const REPO_ID = "01a02000-0000-7000-8000-000000007e90";
const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const IDENTITY: GitHubIdentity = {
  pat: "ghp_dummy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA cogmo-bot",
  login: "cogmo-bot",
  id: "12345",
};

let sendSpy: ReturnType<typeof spyOnInngestSend>;

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
    localPath: "/tmp/repo",
    defaultBranch: "main",
    remoteUrl: "https://github.com/user/cogmo.git",
    devcontainer: null,
    allowedBackends: ["claude"],
    verifyCommand: "pnpm test",
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
    goal: "fix the thing",
    triggerSource: "user",
    triggerRef: null,
    backend: "claude",
    worktreeAssignment: {
      type: "host-path",
      branch: "cogmo/abc12345",
      worktreePath: "/tmp/worktrees/abc12345",
    },
    sessionId: "sess-AAA",
    containerId: null,
    allowPrivilegedRunc: false,
    plan: "1. step\n2. step",
    planApprovedAt: new Date("2026-08-20T00:01:00Z"),
    prMetadata: null,
    status: "pending_verify",
    failureReason: null,
    resourceUsage: null,
    createdAt: new Date("2026-08-20T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Store fake whose reads observe its own writes — the property that turns a
 * bare-body status guard into a self-invalidating one under replay. A
 * stateless `mockResolvedValue` would hide the bug these tests exist for.
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
  store.setTaskPrMetadata.mockImplementation(async (_tx, _id, metadata) => {
    task = { ...task, prMetadata: metadata };
  });
  return { store, current: () => task };
}

function fakeExec(result: { stdout?: string; exitCode?: number }): ExecStreamingHandle {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  if (result.stdout) stdout.write(result.stdout);
  stdout.end();
  stderr.end();
  return {
    stdout: stdout as Readable,
    stderr: stderr as Readable,
    wait: async () => ({ exitCode: result.exitCode ?? 0 }),
    dispose: async () => {},
  };
}

interface ExecLog {
  verify: number;
  push: number;
  revParse: number;
}

function fakeSandbox(log: ExecLog): SandboxClient<LocalDockerSessionState> {
  const state: LocalDockerSessionState = {
    type: "local-docker",
    taskId: TASK_ID,
    containerRowId: "row-1",
    dockerId: "docker-1",
  };
  const session: SandboxSession<LocalDockerSessionState> = {
    state,
    execStreaming: vi.fn(async (cmd: ReadonlyArray<string>) => {
      if (cmd[0] === "bash") {
        log.verify++;
        return fakeExec({ stdout: "PASS\n", exitCode: 0 });
      }
      const sub = cmd.slice(1).find((a) => !a.startsWith("-c") && !a.includes("="));
      if (sub === "push") log.push++;
      if (sub === "rev-parse") {
        log.revParse++;
        return fakeExec({ stdout: `${HEAD_SHA}\n`, exitCode: 0 });
      }
      if (sub === "status") return fakeExec({ stdout: "M src/foo.ts\n", exitCode: 0 });
      return fakeExec({ exitCode: 0 });
    }),
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

function fakeSecrets(): SecretsStore {
  const values = new Map<string, string>([
    [gitHubIdentitySecretName("default"), serializeGitHubIdentity(IDENTITY)],
    ["claude_code_oauth_token", "sk-test-claude-code-oauth-token"],
  ]);
  const store = mock<SecretsStore>();
  store.getSecret.mockImplementation(async (_tx, name: string) => values.get(name));
  return store;
}

function makeDeps(
  store: CodingStore,
  log: ExecLog,
  create: ReturnType<typeof vi.fn>,
): VerifyOrchestratorDeps {
  return {
    runInTx: fakeRunInTx,
    store,
    sandbox: fakeSandbox(log),
    secretsStore: fakeSecrets(),
    askpassBaseDir: "/tmp/cogmo-replay-askpass",
    devbaseImage: "alpine",
    defaultResourceLimits: { cpus: 1, memory_bytes: 1 << 30, pids: 64 },
    taskTtlMs: 60_000,
    octokitFactory: () => ({ pulls: { create } }) as unknown as Octokit,
  };
}

function openedPr(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    data: {
      html_url: "https://github.com/user/cogmo/pull/7",
      number: 7,
      head: { sha: HEAD_SHA },
      created_at: "2026-08-20T00:02:00Z",
    },
  }));
}

const cliDoneEvent = {
  name: "coding/task/cli-done",
  data: { taskId: TASK_ID },
} as const;

describe("coding-task-verify — Inngest replay", () => {
  it("verifies, pushes, and opens the PR exactly once across the run's boundaries", async () => {
    const { store, current } = statefulStore(taskRow({}));
    const log: ExecLog = { verify: 0, push: 0, revParse: 0 };
    const create = openedPr();
    const fn = createCodingVerifyOrchestrator(makeDeps(store, log, create), inngest);

    const engine = new InngestTestEngine({ function: fn, events: [cliDoneEvent] });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    // `set-status-verifying` flips the row to `verifying` on the first
    // invocation, and every later re-invocation re-reads it at the top of
    // the body. A bare-body `status !== "pending_verify"` guard returns
    // `skipped` there — the task never reaches `pr_open` and sits in
    // `verifying` forever.
    expect(result).toEqual({
      status: "pr_open",
      prUrl: "https://github.com/user/cogmo/pull/7",
      prNumber: 7,
    });
    expect(current().status).toBe("pr_open");

    // One test-suite run, one push, one PR — not one per remaining boundary.
    expect(log.verify).toBe(1);
    expect(log.push).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    // `openedAt` is stamped by `runOpenPr` at call time — now inside the
    // memoized step, so it is pinned to the one invocation that opened the
    // PR instead of drifting with each re-invocation.
    expect(current().prMetadata).toEqual({
      url: "https://github.com/user/cogmo/pull/7",
      number: 7,
      branchSha: HEAD_SHA,
      openedAt: expect.any(String),
    });
  });

  it("serves a cached verify verdict without re-running the suite", async () => {
    const { store } = statefulStore(taskRow({}));
    const log: ExecLog = { verify: 0, push: 0, revParse: 0 };
    const create = openedPr();
    const fn = createCodingVerifyOrchestrator(makeDeps(store, log, create), inngest);

    const engine = new InngestTestEngine({
      function: fn,
      events: [cliDoneEvent],
      // Simulate: a prior attempt already ran the suite and Inngest is
      // re-invoking with that result in state.
      steps: [
        {
          id: "run-verify",
          handler: () => ({
            ok: true,
            exitCode: 0,
            output: "[cached PASS]",
            durationMs: 42,
            timedOut: false,
          }),
        },
      ],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ status: "pr_open" });
    expect(log.verify).toBe(0);
    // The cached output is what reaches the PR body — proof the memoized
    // value flows through rather than being silently recomputed.
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0]?.[0] as { body: string } | undefined;
    expect(body?.body).toContain("[cached PASS]");
  });

  it("skips a duplicate event before reaching the failure machinery", async () => {
    // A duplicate `cli-done` for a task that already finished. The
    // conditional UPDATE matches no row, so the run must return `skipped`
    // without running identity resolution — whose failure would otherwise
    // flip an already-terminal task to `failed`.
    const { store, current } = statefulStore(taskRow({ status: "pr_open" }));
    const log: ExecLog = { verify: 0, push: 0, revParse: 0 };
    const create = openedPr();
    const fn = createCodingVerifyOrchestrator(makeDeps(store, log, create), inngest);

    const engine = new InngestTestEngine({ function: fn, events: [cliDoneEvent] });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: "skipped" });
    expect(current().status).toBe("pr_open");
    expect(log.verify).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(store.updateTaskStatus).not.toHaveBeenCalled();
  });
});
