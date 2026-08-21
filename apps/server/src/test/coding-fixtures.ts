/**
 * Fixtures for the coding-orchestrator replay tests.
 *
 * The store fake is the interesting piece: its reads observe its own writes.
 * That is what lets these tests see the hazard they exist for — a re-invoked
 * body's `getTask` returns the status the run itself committed one boundary
 * earlier, so a guard built on it self-invalidates. A stateless
 * `mockResolvedValue` would hide that entirely.
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
 * `CodingStore` whose task-row reads reflect its own writes — every lifecycle
 * method the three orchestrators call, not just the ones a current assertion
 * reads. A silently dropped write leaves `current()` reporting a stale null,
 * so a later test asserting on that field would pass against an orchestrator
 * that never wrote it. Everything else stays the `mock<CodingStore>()`
 * auto-mock.
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
      ...(params.planApprovedAt !== undefined && { planApprovedAt: params.planApprovedAt }),
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
  store.setTaskContainerId.mockImplementation(async (_tx, _id, containerId) => {
    task = { ...task, containerId };
  });
  store.setTaskResourceUsage.mockImplementation(async (_tx, _id, usage) => {
    // The real store merges into the existing blob rather than replacing it.
    task = { ...task, resourceUsage: { ...(task.resourceUsage ?? {}), ...usage } };
  });
  store.setTaskSandboxDeletedAt.mockImplementation(async (_tx, _id, deletedAt) => {
    // Real store gates on a sandbox block existing AND `deleted_at` being
    // unset, which makes the stamp idempotent under replay. Mirroring both
    // keeps "deleted_at without created_at" unrepresentable and stops a
    // double stamp passing here that the real store would ignore.
    const sandbox = task.resourceUsage?.sandbox;
    if (!sandbox || sandbox.deleted_at) return;
    task = {
      ...task,
      resourceUsage: { ...task.resourceUsage, sandbox: { ...sandbox, deleted_at: deletedAt } },
    };
  });
  store.getCodingAutoapproveModeForTask.mockResolvedValue("off");
  store.approvePlanIfPending.mockImplementation(async (_tx, _id, approvedAt) => {
    // Left as an auto-mock this returns undefined, and the orchestrator's
    // `approveResult.kind` read then falls silently into its skipped branch —
    // an auto-approve test would assert nothing.
    if (task.status !== "awaiting_approval") return { kind: "not_pending", status: task.status };
    if (task.planApprovedAt) return { kind: "already_approved", approvedAt: task.planApprovedAt };
    task = { ...task, planApprovedAt: approvedAt };
    return { kind: "approved", conversationId: task.conversationId };
  });
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
  /** `resume` call count — pins the lazy handle's at-most-once contract. */
  resumeCalls: () => number;
  /**
   * Make `tryResumeByTaskId` report a live container, so the execute
   * orchestrator takes its resume-hit branch. That branch skips
   * `persist-container-id`, `checkout-feature-branch` and the sandbox usage
   * stamp, i.e. plans a visibly different step graph, and is the branch a
   * re-delivered `plan-approved` most often takes.
   */
  setResumable: (resumable: boolean) => void;
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
  let resumes = 0;
  let resumable = false;
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
    resume: vi.fn(async () => {
      resumes++;
      return session;
    }),
    tryResumeByTaskId: vi.fn(async () => (resumable ? session : null)),
    delete: vi.fn(async () => {}),
    deleteByTaskId: vi.fn(async () => {
      teardowns++;
    }),
    serializeState: (s) => LocalDockerSessionStateSchema.parse(s),
    deserializeState: (payload) => LocalDockerSessionStateSchema.parse(payload),
    shutdown: vi.fn(async () => {}),
  };
  return {
    sandbox,
    teardownCalls: () => teardowns,
    resumeCalls: () => resumes,
    setResumable: (next: boolean) => {
      resumable = next;
    },
  };
}
