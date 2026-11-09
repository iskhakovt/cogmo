import { err, ok, type Result } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { logger } from "../../logger.js";
import type { SandboxCapabilities } from "../../sandbox/index.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { codingRepoRow } from "../../test/coding-fixtures.js";
import { fakeRunInTx, makeStepRun, nullStepSendEvent } from "../../test/factories.js";
import type { CodingRun } from "./coding-run.js";
import type { CodingStore } from "./store/index.js";
import type { WorktreeAssignment } from "./types.js";

/** Each git and store effect the step had, in order. */
const effects = vi.hoisted((): string[] => []);

const gitMocks = vi.hoisted(() => ({
  loadIdentity: vi.fn<(args: unknown) => Promise<GitHubIdentity>>(),
  fetchDefaultBranchTip: vi.fn<(args: { defaultBranch: string }) => Promise<string>>(),
  pushTaskBranchToRemote:
    vi.fn<
      (args: {
        taskId: string;
        baseSha: string;
      }) => Promise<Result<void, { kind: "base_missing"; baseSha: string }>>
    >(),
}));
vi.mock("./git-as-transport.js", () => gitMocks);

const worktreeMocks = vi.hoisted(() => ({
  allocateWorktree: vi.fn<(args: { branch: string; baseSha: string | null }) => Promise<void>>(),
  readHeadSha: vi.fn<(repoPath: string) => Promise<string | null>>(),
}));
vi.mock("./worktree.js", () => worktreeMocks);

import { allocateTaskWorktree } from "./allocate-task-worktree.js";

const TASK_ID = "019e0df3-be2c-78b2-a392-c19ef36d1ff4";
const BRANCH = "cogmo/019e0df3be2c";
const MAIN = "1111111111111111111111111111111111111111";
const MOVED_MAIN = "2222222222222222222222222222222222222222";
const PARENT_HEAD = "4444444444444444444444444444444444444444";
const SAVED = "3333333333333333333333333333333333333333";
const IDENTITY: GitHubIdentity = {
  pat: "ghp_test",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA",
  login: "cogmo-bot",
  id: "12345",
};
const REPO = codingRepoRow({ name: "skills", localPath: "/srv/skills.git" });
const WORKTREES_DIR = "/srv/worktrees";
const WORKTREE_PATH = `${WORKTREES_DIR}/skills/019e0df3be2c`;

function capabilities(
  workingTreeTransport: SandboxCapabilities["workingTreeTransport"],
): SandboxCapabilities {
  return {
    siblingContainers: "sandbox-internal",
    hostBindMount: workingTreeTransport === "bind-mount",
    customImage: true,
    volumes: "managed",
    workingTreeTransport,
    depsCacheSharing: "per-sandbox",
    noNetworkSessions: false,
  };
}

function harness(transport: SandboxCapabilities["workingTreeTransport"]) {
  const store = mock<CodingStore>();
  store.setTaskWorktreeAssignment.mockImplementation(async (_tx, _id, assignment) => {
    effects.push(`persist ${JSON.stringify(assignment)}`);
  });
  const run: CodingRun = {
    taskId: TASK_ID,
    runId: "run-1",
    stepRun: makeStepRun(),
    stepSendEvent: nullStepSendEvent(),
    log: logger,
  };
  const deps = {
    runInTx: fakeRunInTx,
    store,
    sandbox: { capabilities: capabilities(transport) },
    secretsStore: mock<SecretsStore>(),
    worktreesDir: WORKTREES_DIR,
  };
  const assigned: WorktreeAssignment[] = [];
  const allocate = (persisted: WorktreeAssignment | null) =>
    allocateTaskWorktree(run, deps, {
      repo: REPO,
      persisted,
      onAssigned: (assignment) => assigned.push(assignment),
    });
  return { store, allocate, assigned };
}

beforeEach(() => {
  effects.length = 0;
  gitMocks.loadIdentity.mockResolvedValue(IDENTITY);
  gitMocks.fetchDefaultBranchTip.mockImplementation(async ({ defaultBranch }) => {
    effects.push(`fetch ${defaultBranch}`);
    return MAIN;
  });
  gitMocks.pushTaskBranchToRemote.mockImplementation(async ({ baseSha }) => {
    effects.push(`push ${baseSha}`);
    return ok(undefined);
  });
  worktreeMocks.readHeadSha.mockImplementation(async (repoPath) => {
    effects.push(`read HEAD of ${repoPath}`);
    return PARENT_HEAD;
  });
  worktreeMocks.allocateWorktree.mockImplementation(async ({ baseSha }) => {
    effects.push(`cut ${baseSha}`);
  });
});

describe("allocateTaskWorktree on host-path", () => {
  it("reads the parent's HEAD, saves it with the assignment, then cuts the branch at it", async () => {
    const h = harness("bind-mount");

    const outcome = await h.allocate(null);

    const expected = {
      type: "host-path",
      branch: BRANCH,
      worktreePath: WORKTREE_PATH,
      baseSha: PARENT_HEAD,
    };
    expect(outcome).toEqual({ kind: "allocated", assignment: expected });
    expect(h.assigned).toEqual([expected]);
    expect(effects).toEqual([
      `read HEAD of ${REPO.localPath}`,
      `persist ${JSON.stringify(expected)}`,
      `cut ${PARENT_HEAD}`,
    ]);
    expect(worktreeMocks.allocateWorktree).toHaveBeenCalledWith({
      repoPath: REPO.localPath,
      branch: BRANCH,
      worktreePath: WORKTREE_PATH,
      remoteUrl: REPO.remoteUrl,
      baseSha: PARENT_HEAD,
    });
  });

  it("a retry cuts at the saved base after the parent's HEAD moved, writing nothing", async () => {
    const h = harness("bind-mount");
    worktreeMocks.readHeadSha.mockResolvedValue(MOVED_MAIN);
    const saved: WorktreeAssignment = {
      type: "host-path",
      branch: BRANCH,
      worktreePath: WORKTREE_PATH,
      baseSha: SAVED,
    };

    const outcome = await h.allocate(saved);

    expect(outcome).toEqual({ kind: "allocated", assignment: saved });
    expect(effects).toEqual([`cut ${SAVED}`]);
    expect(h.store.setTaskWorktreeAssignment).not.toHaveBeenCalled();
  });

  it("an assignment saved before the base was recorded cuts at the parent's HEAD", async () => {
    const h = harness("bind-mount");
    const legacy: WorktreeAssignment = {
      type: "host-path",
      branch: BRANCH,
      worktreePath: WORKTREE_PATH,
    };

    const outcome = await h.allocate(legacy);

    expect(outcome).toEqual({ kind: "allocated", assignment: legacy });
    expect(effects).toEqual(["cut null"]);
  });

  it("an empty parent saves no base and cuts as without one", async () => {
    const h = harness("bind-mount");
    worktreeMocks.readHeadSha.mockResolvedValue(null);

    const outcome = await h.allocate(null);

    const expected = { type: "host-path", branch: BRANCH, worktreePath: WORKTREE_PATH };
    expect(outcome).toStrictEqual({ kind: "allocated", assignment: expected });
    expect(h.assigned).toStrictEqual([expected]);
    expect(effects).toEqual([`persist ${JSON.stringify(expected)}`, "cut null"]);
  });

  it("saves no assignment when the base cannot be read", async () => {
    const h = harness("bind-mount");
    worktreeMocks.readHeadSha.mockRejectedValue(new Error("HEAD names no commit"));

    await expect(h.allocate(null)).rejects.toThrow("HEAD names no commit");

    expect(h.assigned).toEqual([]);
    expect(h.store.setTaskWorktreeAssignment).not.toHaveBeenCalled();
    expect(worktreeMocks.allocateWorktree).not.toHaveBeenCalled();
  });
});

describe("allocateTaskWorktree on git-remote", () => {
  it("fetches the remote's main, saves it with the assignment, then pushes the run branch at it", async () => {
    const h = harness("git-remote");

    const outcome = await h.allocate(null);

    const expected = { type: "git-remote", branch: BRANCH, baseSha: MAIN };
    expect(outcome).toEqual({ kind: "allocated", assignment: expected });
    expect(h.assigned).toEqual([expected]);
    expect(effects).toEqual(["fetch main", `persist ${JSON.stringify(expected)}`, `push ${MAIN}`]);
    expect(gitMocks.pushTaskBranchToRemote).toHaveBeenCalledWith({
      localRepoPath: REPO.localPath,
      remoteUrl: REPO.remoteUrl,
      taskId: TASK_ID,
      defaultBranch: "main",
      baseSha: MAIN,
      identity: IDENTITY,
    });
    expect(worktreeMocks.allocateWorktree).not.toHaveBeenCalled();
  });

  it("a retry pushes the saved base after the remote's main moved, fetching nothing", async () => {
    const h = harness("git-remote");
    gitMocks.fetchDefaultBranchTip.mockResolvedValue(MOVED_MAIN);
    const saved: WorktreeAssignment = { type: "git-remote", branch: BRANCH, baseSha: SAVED };

    const outcome = await h.allocate(saved);

    expect(outcome).toEqual({ kind: "allocated", assignment: saved });
    expect(effects).toEqual([`push ${SAVED}`]);
    expect(gitMocks.fetchDefaultBranchTip).not.toHaveBeenCalled();
    expect(h.store.setTaskWorktreeAssignment).not.toHaveBeenCalled();
  });

  it("a retry whose saved base is nowhere to be had ends push_failed naming it, picking no other", async () => {
    const h = harness("git-remote");
    gitMocks.pushTaskBranchToRemote.mockResolvedValue(
      err({ kind: "base_missing", baseSha: SAVED }),
    );
    const saved: WorktreeAssignment = { type: "git-remote", branch: BRANCH, baseSha: SAVED };

    const outcome = await h.allocate(saved);

    expect(outcome).toEqual({
      kind: "base_missing",
      assignment: saved,
      failure: { reason: "push_failed", detail: expect.stringContaining(SAVED) },
    });

    expect(gitMocks.pushTaskBranchToRemote).toHaveBeenCalledWith(
      expect.objectContaining({ baseSha: SAVED }),
    );
    expect(gitMocks.fetchDefaultBranchTip).not.toHaveBeenCalled();
    expect(h.store.setTaskWorktreeAssignment).not.toHaveBeenCalled();
  });

  it("an assignment saved before the base was recorded pushes the fresh tip and records none", async () => {
    const h = harness("git-remote");
    const legacy: WorktreeAssignment = { type: "git-remote", branch: BRANCH };

    const outcome = await h.allocate(legacy);

    expect(outcome).toEqual({ kind: "allocated", assignment: legacy });
    expect(effects).toEqual(["fetch main", `push ${MAIN}`]);
    expect(h.store.setTaskWorktreeAssignment).not.toHaveBeenCalled();
  });

  it("saves no assignment when the fetch fails", async () => {
    const h = harness("git-remote");
    gitMocks.fetchDefaultBranchTip.mockRejectedValue(new Error("network unreachable"));

    await expect(h.allocate(null)).rejects.toThrow("network unreachable");

    expect(h.assigned).toEqual([]);
    expect(h.store.setTaskWorktreeAssignment).not.toHaveBeenCalled();
    expect(gitMocks.pushTaskBranchToRemote).not.toHaveBeenCalled();
  });
});
