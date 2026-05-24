import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { bootstrapSkillsRepo, SKILLS_CODING_REPO_NAME } from "../../skills/repo.js";
import type { RegisterResult, SkillRunner } from "../../skills/runner.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { autoRegisterSkill } from "./auto-register-skill.js";
import { DrizzleCodingStore } from "./store/index.js";

const execFileP = promisify(execFile);

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleCodingStore;
let baseDir: string;
let bareRepoPath: string;
let upstreamPath: string;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleCodingStore();
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-auto-register-test-"));
});

beforeEach(async () => {
  // Fresh bare + upstream pair per test so fetch state doesn't bleed.
  bareRepoPath = mkdtempSync(join(baseDir, "skills-bare-"));
  upstreamPath = mkdtempSync(join(baseDir, "skills-upstream-"));
  await bootstrapSkillsRepo({ path: bareRepoPath });

  // Seed an upstream repo with a main commit + a runBranch carrying SKILL.md
  // + skill.py, then point the bare repo's origin at it.
  await execFileP("git", ["init", "--initial-branch=main", upstreamPath]);
  await execFileP("git", ["-C", upstreamPath, "config", "user.email", "test@cogmo"]);
  await execFileP("git", ["-C", upstreamPath, "config", "user.name", "test"]);
  await execFileP("git", ["-C", upstreamPath, "commit", "--allow-empty", "-m", "init"]);
});

afterEach(async () => {
  await truncateAll(db);
  rmSync(bareRepoPath, { recursive: true, force: true });
  rmSync(upstreamPath, { recursive: true, force: true });
});

afterAll(async () => {
  rmSync(baseDir, { recursive: true, force: true });
  await close();
});

const validIdentity = JSON.stringify({
  pat: "ghp_test",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA",
  login: "cogmo-bot",
  id: "12345",
});

function fakeSecretsStore(secret: string | undefined): SecretsStore {
  const m = mock<SecretsStore>();
  m.getSecret.mockResolvedValue(secret);
  return m;
}

async function seedRepoAndTask(
  repoName: string,
  opts: { withWorktreeAssignment?: boolean } = {},
): Promise<{ taskId: string; branch: string }> {
  const repo = await tx((trx) =>
    store.insertRepo(trx, {
      name: repoName,
      localPath: bareRepoPath,
      defaultBranch: "main",
      remoteUrl: upstreamPath,
      devcontainer: null,
      allowedBackends: ["claude"],
      verifyCommand: "true",
      taskTokenBudget: 100_000,
      taskWallTimeSeconds: 60,
      maxConcurrentTasks: 1,
    }),
  );
  const task = await tx((trx) =>
    store.insertTask(trx, {
      repoId: repo.id,
      goal: "test",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    }),
  );
  const branch = `cogmo/${task.id.replace(/-/g, "").slice(0, 12)}`;
  if (opts.withWorktreeAssignment !== false) {
    await tx((trx) =>
      store.setTaskWorktreeAssignment(trx, task.id, { type: "git-remote", branch }),
    );
  }
  return { taskId: task.id, branch };
}

async function pushBranchToUpstream(branch: string): Promise<void> {
  await execFileP("git", ["-C", upstreamPath, "checkout", "-b", branch]);
  await execFileP("git", ["-C", upstreamPath, "commit", "--allow-empty", "-m", "skill commit"]);
}

describe("autoRegisterSkill", () => {
  it("skips non-skills repos", async () => {
    const { taskId } = await seedRepoAndTask("example");
    const skillRunner = mock<SkillRunner>();

    const result = await autoRegisterSkill(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(validIdentity),
        skillRunner,
        skillsRepoPath: bareRepoPath,
      },
      { taskId },
    );

    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toMatch(/not the skills repo/);
    expect(skillRunner.register).not.toHaveBeenCalled();
  });

  it("skips when task row is missing", async () => {
    const skillRunner = mock<SkillRunner>();
    const result = await autoRegisterSkill(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(validIdentity),
        skillRunner,
        skillsRepoPath: bareRepoPath,
      },
      { taskId: "01900000-0000-7000-8000-000000000000" },
    );
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toMatch(/task row not found/);
    expect(skillRunner.register).not.toHaveBeenCalled();
  });

  it("skips when github identity is missing", async () => {
    const { taskId } = await seedRepoAndTask(SKILLS_CODING_REPO_NAME);
    const skillRunner = mock<SkillRunner>();
    const result = await autoRegisterSkill(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(undefined),
        skillRunner,
        skillsRepoPath: bareRepoPath,
      },
      { taskId },
    );
    expect(result.kind).toBe("skipped");
    expect(skillRunner.register).not.toHaveBeenCalled();
  });

  it("skips when worktree_assignment is null", async () => {
    const { taskId } = await seedRepoAndTask(SKILLS_CODING_REPO_NAME, {
      withWorktreeAssignment: false,
    });
    const skillRunner = mock<SkillRunner>();
    const result = await autoRegisterSkill(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(validIdentity),
        skillRunner,
        skillsRepoPath: bareRepoPath,
      },
      { taskId },
    );
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toMatch(/worktree_assignment is null/);
    expect(skillRunner.register).not.toHaveBeenCalled();
  });

  it("fetches the PR branch and calls runner.register for the skills repo", async () => {
    const { taskId, branch } = await seedRepoAndTask(SKILLS_CODING_REPO_NAME);
    await pushBranchToUpstream(branch);

    const registerResult: RegisterResult = {
      name: "btc-spot",
      riskTier: "notify",
      status: "live",
      gitSha: "abc123",
      errors: [],
    };
    const skillRunner = mock<SkillRunner>();
    skillRunner.register.mockResolvedValue(registerResult);

    const result = await autoRegisterSkill(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(validIdentity),
        skillRunner,
        skillsRepoPath: bareRepoPath,
      },
      { taskId },
    );

    expect(result.kind).toBe("registered");
    if (result.kind === "registered") {
      expect(result.branch).toBe(branch);
      expect(result.result).toBe(registerResult);
    }
    expect(skillRunner.register).toHaveBeenCalledWith({ branch });

    const { stdout } = await execFileP("git", [
      "-C",
      bareRepoPath,
      "rev-parse",
      `refs/heads/${branch}`,
    ]);
    expect(stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
