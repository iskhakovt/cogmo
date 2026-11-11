import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import { SKILLS_CODING_REPO_NAME } from "../../skills/repo.js";
import type { RegisterDryRun } from "../../skills/runner.js";
import { expectDefined, expectOk } from "../../test/assertions.js";
import { parkCodingTaskAt } from "../../test/coding-fixtures.js";
import { nullStepSendEvent, recordingStepRun } from "../../test/factories.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import type { CodingRun } from "./coding-run.js";
import { type PresubmitDeps, runPresubmit } from "./presubmit-stage.js";
import { type CodingRepoRow, type CodingTaskStatus, DrizzleCodingStore } from "./store/index.js";

const execFileP = promisify(execFile);
const git = async (...args: string[]) => (await execFileP("git", args)).stdout.trim();

const BRANCH = "cogmo/abc12345";
const IDENTITY: GitHubIdentity = {
  pat: "ghp_test",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA",
  login: "cogmo-bot",
  id: "12345",
};

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleCodingStore();
let root: string;
let upstream: string;
let bare: string;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogmo-presubmit-"));
  upstream = join(root, "upstream");
  bare = join(root, "skills.git");
  await git("init", "-q", "-b", "main", upstream);
  await git(
    "-C",
    upstream,
    "-c",
    "user.email=t@cogmo",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  await git("init", "-q", "--bare", bare);
});

afterEach(async () => {
  await truncateAll(db);
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

afterAll(async () => {
  await close();
});

/** Pushes `BRANCH` upstream with one more commit; its tip. */
async function pushBranch(): Promise<string> {
  await git("-C", upstream, "checkout", "-q", "-B", BRANCH);
  await git(
    "-C",
    upstream,
    "-c",
    "user.email=t@cogmo",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "skill",
  );
  return git("-C", upstream, "rev-parse", "HEAD");
}

async function seed(
  status: CodingTaskStatus,
  name: string,
): Promise<{ taskId: string; repo: CodingRepoRow }> {
  const repo = await tx((trx) =>
    store
      .insertRepo(trx, {
        name,
        localPath: bare,
        defaultBranch: "main",
        remoteUrl: upstream,
        devcontainer: null,
        allowedBackends: ["claude"],
        verifyCommand: "true",
        taskTokenBudget: 100_000,
        taskWallTimeSeconds: 60,
        maxConcurrentTasks: 1,
      })
      .then(expectOk),
  );
  const task = await tx((trx) =>
    store.insertTask(trx, {
      repoId: repo.id,
      goal: "write a skill",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    }),
  );
  await parkCodingTaskAt(tx, store, task.id, status);
  return { taskId: task.id, repo };
}

function harness(taskId: string, runId: string) {
  const recording = recordingStepRun();
  const skillRunner = mock<PresubmitDeps["skillRunner"]>();
  const run: CodingRun = {
    taskId,
    runId,
    stepRun: recording.stepRun,
    stepSendEvent: nullStepSendEvent(),
    log: logger.child({ taskId }),
  };
  const deps = {
    runInTx: tx,
    store,
    presubmit: { skillRunner, skillsRepoPath: bare, releaseVersion: "2.17.0" },
  };
  return { run, deps, skillRunner, steps: recording.ids };
}

const verdictOf = async (taskId: string) =>
  (await tx((trx) => store.getTask(trx, taskId)))?.presubmitVerdict ?? null;
const scratchRefs = () => git("-C", bare, "for-each-ref", "refs/cogmo-presubmit/");

describe("runPresubmit", () => {
  it("plans no step on another repo than the skills repo", async () => {
    const { taskId, repo } = await seed("verifying", "cogmo");
    const h = harness(taskId, "verify-run-1");

    await runPresubmit(h.run, h.deps, {
      repo,
      branch: BRANCH,
      branchSha: "a".repeat(40),
      identity: IDENTITY,
    });

    expect(h.steps).toEqual([]);
    expect(h.skillRunner.checkRegister).not.toHaveBeenCalled();
  });

  it("dry-runs the fetched tip and records the verdict under the run's key, the scratch ref gone", async () => {
    const { taskId, repo } = await seed("verifying", SKILLS_CODING_REPO_NAME);
    const sha = await pushBranch();
    const h = harness(taskId, "verify-run-1");
    const refused: RegisterDryRun = {
      kind: "refused",
      sha,
      findings: ["ruff: skills/echo/skill.py:1:1: E501"],
    };
    h.skillRunner.checkRegister.mockResolvedValue(refused);

    await runPresubmit(h.run, h.deps, { repo, branch: BRANCH, branchSha: sha, identity: IDENTITY });

    expect(h.steps).toEqual(["presubmit"]);
    expect(h.skillRunner.checkRegister).toHaveBeenCalledWith({
      sha,
      signal: expect.any(AbortSignal),
    });
    expect(await verdictOf(taskId)).toEqual({
      ...refused,
      runId: "verify-run-1",
      fixPass: 0,
      checkedAt: expect.any(String),
      releaseVersion: "2.17.0",
    });
    expect(await scratchRefs()).toBe("");
  });

  it("a re-run after its own write returns the stored verdict with no second dry run; a later run judges afresh", async () => {
    const { taskId, repo } = await seed("verifying", SKILLS_CODING_REPO_NAME);
    const sha = await pushBranch();
    const args = { repo, branch: BRANCH, branchSha: sha, identity: IDENTITY };
    // Each call stands for the step running again: Inngest recorded no result.
    const results: unknown[] = [];
    const h = harness(taskId, "verify-run-1");
    h.run.stepRun = async (_id, fn) => {
      const result = await fn();
      results.push(result);
      return result;
    };
    h.skillRunner.checkRegister.mockResolvedValue({ kind: "passed", sha, riskTier: "notify" });

    await runPresubmit(h.run, h.deps, args);
    await runPresubmit(h.run, h.deps, args);

    expect(h.skillRunner.checkRegister).toHaveBeenCalledTimes(1);
    expect(results[1]).toEqual(results[0]);
    expect(results[1]).toEqual({ verdict: await verdictOf(taskId) });

    const later = harness(taskId, "verify-run-2");
    later.skillRunner.checkRegister.mockResolvedValue({ kind: "passed", sha, riskTier: "auto" });
    await runPresubmit(later.run, later.deps, args);
    expect(later.skillRunner.checkRegister).toHaveBeenCalledTimes(1);
    expect(await verdictOf(taskId)).toMatchObject({ runId: "verify-run-2", riskTier: "auto" });
  });

  it("judges nothing when another push moved the branch, or the fetch fails", async () => {
    const { taskId, repo } = await seed("verifying", SKILLS_CODING_REPO_NAME);
    const sha = await pushBranch();
    const h = harness(taskId, "verify-run-1");

    await runPresubmit(h.run, h.deps, {
      repo,
      branch: BRANCH,
      branchSha: "c".repeat(40),
      identity: IDENTITY,
    });
    expect(await verdictOf(taskId)).toMatchObject({
      kind: "unavailable",
      sha,
      cause: "branch_moved",
    });

    const fresh = harness(taskId, "verify-run-2");
    await runPresubmit(fresh.run, fresh.deps, {
      repo,
      branch: "cogmo/missing",
      branchSha: sha,
      identity: IDENTITY,
    });
    expect(await verdictOf(taskId)).toMatchObject({
      kind: "unavailable",
      sha: null,
      cause: "fetch_failed",
      detail: expect.stringContaining("cogmo/missing"),
    });
    expect(h.skillRunner.checkRegister).not.toHaveBeenCalled();
    expect(fresh.skillRunner.checkRegister).not.toHaveBeenCalled();
    expect(await scratchRefs()).toBe("");
  });

  it("judges nothing at the deadline, and fails the step on any other throw", async () => {
    const { taskId, repo } = await seed("verifying", SKILLS_CODING_REPO_NAME);
    const sha = await pushBranch();
    const args = { repo, branch: BRANCH, branchSha: sha, identity: IDENTITY };
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const h = harness(taskId, "verify-run-1");
    h.skillRunner.checkRegister.mockImplementation(async ({ signal }) => {
      deadline.abort(new DOMException("signal timed out", "TimeoutError"));
      throw signal.reason;
    });

    await runPresubmit(h.run, h.deps, args);
    expect(await verdictOf(taskId)).toMatchObject({
      kind: "unavailable",
      sha,
      cause: "deadline",
      detail: "signal timed out",
    });

    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    const broken = harness(taskId, "verify-run-2");
    broken.skillRunner.checkRegister.mockRejectedValue(new Error("a bug"));
    await expect(runPresubmit(broken.run, broken.deps, args)).rejects.toThrow("a bug");
    expect(await verdictOf(taskId)).toMatchObject({ runId: "verify-run-1" });
    expect(await scratchRefs()).toBe("");

    // A deadline that passes during the fetch leaves no sha to name.
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const late = harness(taskId, "verify-run-3");
    await runPresubmit(late.run, late.deps, args);
    expect(await verdictOf(taskId)).toMatchObject({
      kind: "unavailable",
      sha: null,
      cause: "deadline",
      runId: "verify-run-3",
    });
    expect(late.skillRunner.checkRegister).not.toHaveBeenCalled();
  });

  it("a scratch ref that will not delete is logged, and the verdict still recorded", async () => {
    const { taskId, repo } = await seed("verifying", SKILLS_CODING_REPO_NAME);
    const sha = await pushBranch();
    const h = harness(taskId, "verify-run-1");
    const warn = vi.spyOn(h.run.log, "warn");
    const ref = `refs/cogmo-presubmit/${taskId}`;
    h.skillRunner.checkRegister.mockImplementation(async () => {
      // Another writer's lock on the ref, which `update-ref -d` cannot take.
      await writeFile(join(bare, `${ref}.lock`), "");
      return { kind: "passed", sha, riskTier: "notify" };
    });

    await runPresubmit(h.run, h.deps, {
      repo,
      branch: BRANCH,
      branchSha: sha,
      identity: IDENTITY,
    });

    expect(await verdictOf(taskId)).toMatchObject({ kind: "passed", runId: "verify-run-1" });
    expect(await git("-C", bare, "rev-parse", ref)).toBe(sha);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ ref }),
      "presubmit: scratch ref not deleted; outside refs/heads/ it is inert",
    );
  });

  it("leaves the row of a task that left verifying during the dry run as it is", async () => {
    const { taskId, repo } = await seed("pushed", SKILLS_CODING_REPO_NAME);
    const sha = await pushBranch();
    const h = harness(taskId, "verify-run-1");
    h.skillRunner.checkRegister.mockResolvedValue({ kind: "passed", sha, riskTier: "notify" });

    await runPresubmit(h.run, h.deps, { repo, branch: BRANCH, branchSha: sha, identity: IDENTITY });

    expect(h.skillRunner.checkRegister).toHaveBeenCalledTimes(1);
    expect(
      expectDefined(await tx((trx) => store.getTask(trx, taskId)), "task").presubmitVerdict,
    ).toBeNull();
  });
});
