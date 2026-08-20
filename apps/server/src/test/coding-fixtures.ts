/**
 * Fixtures for the coding-orchestrator replay tests.
 *
 * The store fake is the interesting piece: its reads observe its own
 * writes. That property is what lets these tests see the hazard they exist
 * for — Inngest re-invokes a function's whole body at every step boundary,
 * so `getTask` at the top of the body returns the status the run itself
 * committed one boundary earlier, and any guard built on that read
 * self-invalidates. A stateless `mockResolvedValue` would hide it.
 */

import { PassThrough } from "node:stream";
import { vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { CodingRepoRow, CodingStore, CodingTaskRow } from "../agent/coding/store/index.js";
import {
  type ExecStreamingHandle,
  type LocalDockerSessionState,
  LocalDockerSessionStateSchema,
  type SandboxClient,
  type SandboxSession,
} from "../sandbox/index.js";

export const FIXTURE_TASK_ID = "01a02000-0000-7000-8000-00000000ta5c";
export const FIXTURE_REPO_ID = "01a02000-0000-7000-8000-000000007e90";

const FIXTURE_EPOCH = new Date("2026-08-20T00:00:00Z");

export function codingRepoRow(overrides: Partial<CodingRepoRow> = {}): CodingRepoRow {
  return {
    id: FIXTURE_REPO_ID,
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
    createdAt: FIXTURE_EPOCH,
    ...overrides,
  };
}

export function codingTaskRow(overrides: Partial<CodingTaskRow> = {}): CodingTaskRow {
  return {
    id: FIXTURE_TASK_ID,
    repoId: FIXTURE_REPO_ID,
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
    idempotencyKey: null,
    createdAt: FIXTURE_EPOCH,
    ...overrides,
  };
}

export interface StatefulCodingStore {
  store: CodingStore;
  /** The task row as the fake's own writes have left it. */
  current: () => CodingTaskRow;
}

/**
 * `CodingStore` whose task-row reads reflect its own writes. Covers the
 * lifecycle methods the three orchestrators touch; every other method stays
 * the `mock<CodingStore>()` auto-mock.
 */
export function statefulCodingStore(
  initialTask: CodingTaskRow,
  repo: CodingRepoRow = codingRepoRow(),
): StatefulCodingStore {
  let task = initialTask;
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
  store.setTaskPrMetadata.mockImplementation(async (_tx, _id, metadata) => {
    task = { ...task, prMetadata: metadata };
  });
  store.setTaskContainerId.mockImplementation(async () => {});
  store.setTaskResourceUsage.mockImplementation(async () => {});
  store.setTaskSandboxDeletedAt.mockImplementation(async () => {});
  store.getCodingAutoapproveModeForTask.mockResolvedValue("off");
  return { store, current: () => task };
}

/** Immediately-closed exec handle scripted with fixed output + exit code. */
export function fakeExecHandle(result: {
  stdout?: string;
  exitCode?: number;
}): ExecStreamingHandle {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  if (result.stdout) stdout.write(result.stdout);
  stdout.end();
  stderr.end();
  return {
    stdout,
    stderr,
    wait: async () => ({ exitCode: result.exitCode ?? 0 }),
    dispose: async () => {},
  };
}

export interface FakeCodingSandbox {
  sandbox: SandboxClient<LocalDockerSessionState>;
  /** `deleteByTaskId` call count — the teardown-runs-once invariant reads this. */
  teardownCalls: () => number;
}

/**
 * Bind-mount `SandboxClient` handing out one reusable session.
 * `execStreaming` is injected so a caller can script git/verify output and
 * count execs.
 */
export function fakeCodingSandbox(
  execStreaming: (cmd: ReadonlyArray<string>) => Promise<ExecStreamingHandle> = async () =>
    fakeExecHandle({}),
): FakeCodingSandbox {
  let teardowns = 0;
  const state: LocalDockerSessionState = {
    type: "local-docker",
    taskId: FIXTURE_TASK_ID,
    containerRowId: "row-1",
    dockerId: "docker-1",
  };
  const session: SandboxSession<LocalDockerSessionState> = {
    state,
    execStreaming: vi.fn(async (cmd: ReadonlyArray<string>) => execStreaming(cmd)),
    exec: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      wallTimeSeconds: 0,
      truncated: false,
    })),
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
    healthCheck: vi.fn(async () => ({ ok: true as const, runtime: "runc" })),
    reconcileCrashedInstances: vi.fn(async () => ({ orphansReaped: 0 })),
    ensureImagePresent: vi.fn(async () => {}),
    create: vi.fn(async () => session),
    resume: vi.fn(async () => session),
    tryResumeByTaskId: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    deleteByTaskId: vi.fn(async () => {
      teardowns++;
    }),
    serializeState: (s) => LocalDockerSessionStateSchema.parse(s),
    deserializeState: (payload) => LocalDockerSessionStateSchema.parse(payload),
    shutdown: vi.fn(async () => {}),
  };
  return { sandbox, teardownCalls: () => teardowns };
}
