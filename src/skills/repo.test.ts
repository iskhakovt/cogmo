import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapSkillsRepo, PRE_RECEIVE_HOOK_CONTENT } from "./repo.js";

const execFileP = promisify(execFile);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "skills-repo-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      // Force a hermetic identity so commits don't depend on the machine's git config.
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return stdout;
}

async function gitFails(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  try {
    await execFileP("git", ["-C", cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    throw new Error("expected git command to fail");
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

async function setupClone(bareRepo: string, cloneDir: string): Promise<void> {
  await execFileP("git", ["clone", bareRepo, cloneDir]);
  // Make a real commit on `main` so we have something to push.
  await execFileP("bash", [
    "-c",
    `cd "${cloneDir}" && \
       git checkout -b main && \
       echo hello > file.txt && \
       git add file.txt && \
       GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com \
       GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com \
       git commit -m initial`,
  ]);
}

describe("bootstrapSkillsRepo", () => {
  it("initializes a bare repo on first call and reports initialized: true", async () => {
    const repoPath = join(workDir, "skills");
    const result = await bootstrapSkillsRepo({ path: repoPath });
    expect(result.initialized).toBe(true);
    expect(result.path).toBe(repoPath);
    expect(existsSync(join(repoPath, "HEAD"))).toBe(true);
    // Bare repo has no working tree directory.
    expect(existsSync(join(repoPath, ".git"))).toBe(false);
  });

  it("is idempotent — second call reports initialized: false", async () => {
    const repoPath = join(workDir, "skills");
    await bootstrapSkillsRepo({ path: repoPath });
    const second = await bootstrapSkillsRepo({ path: repoPath });
    expect(second.initialized).toBe(false);
  });

  it("installs the pre-receive hook with mode 0755 and matching content", async () => {
    const repoPath = join(workDir, "skills");
    await bootstrapSkillsRepo({ path: repoPath });
    const hookPath = join(repoPath, "hooks", "pre-receive");
    const content = await readFile(hookPath, "utf8");
    expect(content).toBe(PRE_RECEIVE_HOOK_CONTENT);
    const st = await stat(hookPath);
    // Mode bits: world-readable + owner-executable.
    // biome-ignore lint/style/noMagicNumbers: 0o755 is the standard executable mode for hooks
    expect(st.mode & 0o777).toBe(0o755);
  });

  it("rewrites the hook on every call (Cogmo-managed file)", async () => {
    const repoPath = join(workDir, "skills");
    await bootstrapSkillsRepo({ path: repoPath });
    const hookPath = join(repoPath, "hooks", "pre-receive");

    // Operator manually modifies the hook (e.g. tries to disable it).
    await execFileP("bash", ["-c", `echo '#!/bin/sh\nexit 0' > "${hookPath}"`]);
    expect(await readFile(hookPath, "utf8")).not.toBe(PRE_RECEIVE_HOOK_CONTENT);

    await bootstrapSkillsRepo({ path: repoPath });
    expect(await readFile(hookPath, "utf8")).toBe(PRE_RECEIVE_HOOK_CONTENT);
  });

  it("rejects a direct push to main", async () => {
    const repoPath = join(workDir, "skills");
    const cloneDir = join(workDir, "clone");
    await bootstrapSkillsRepo({ path: repoPath });
    await setupClone(repoPath, cloneDir);

    const { stderr } = await gitFails(cloneDir, "push", "origin", "main:main");
    expect(stderr).toContain("Direct pushes to main are not allowed");
  });

  it("accepts a push to a feature branch", async () => {
    const repoPath = join(workDir, "skills");
    const cloneDir = join(workDir, "clone");
    await bootstrapSkillsRepo({ path: repoPath });
    await setupClone(repoPath, cloneDir);

    await git(cloneDir, "push", "origin", "main:refs/heads/feature/x");
    // Verify the ref landed.
    const refs = await git(repoPath, "for-each-ref", "--format=%(refname)");
    expect(refs).toContain("refs/heads/feature/x");
  });

  it("reinstalls the hook if it was deleted between boots", async () => {
    const repoPath = join(workDir, "skills");
    await bootstrapSkillsRepo({ path: repoPath });
    const hookPath = join(repoPath, "hooks", "pre-receive");
    await unlink(hookPath);
    expect(existsSync(hookPath)).toBe(false);
    await bootstrapSkillsRepo({ path: repoPath });
    expect(existsSync(hookPath)).toBe(true);
    expect(await readFile(hookPath, "utf8")).toBe(PRE_RECEIVE_HOOK_CONTENT);
  });

  it("fixes the hook mode if it was downgraded to 0644", async () => {
    const repoPath = join(workDir, "skills");
    await bootstrapSkillsRepo({ path: repoPath });
    const hookPath = join(repoPath, "hooks", "pre-receive");
    // biome-ignore lint/style/noMagicNumbers: explicit mode bits
    await chmod(hookPath, 0o644);
    // biome-ignore lint/style/noMagicNumbers: explicit mode bits
    expect((await stat(hookPath)).mode & 0o777).toBe(0o644);
    await bootstrapSkillsRepo({ path: repoPath });
    // biome-ignore lint/style/noMagicNumbers: explicit mode bits
    expect((await stat(hookPath)).mode & 0o777).toBe(0o755);
  });

  it("accepts a tag push (refs/tags/* not subject to main-protection)", async () => {
    const repoPath = join(workDir, "skills");
    const cloneDir = join(workDir, "clone");
    await bootstrapSkillsRepo({ path: repoPath });
    await setupClone(repoPath, cloneDir);
    await git(cloneDir, "tag", "v1.0.0");
    await git(cloneDir, "push", "origin", "v1.0.0");
    const refs = await git(repoPath, "for-each-ref", "--format=%(refname)");
    expect(refs).toContain("refs/tags/v1.0.0");
  });

  it("accepts a feature-branch deletion (zero newrev — not a force push)", async () => {
    const repoPath = join(workDir, "skills");
    const cloneDir = join(workDir, "clone");
    await bootstrapSkillsRepo({ path: repoPath });
    await setupClone(repoPath, cloneDir);
    await git(cloneDir, "push", "origin", "main:refs/heads/feature/x");
    // Now delete the remote branch.
    await git(cloneDir, "push", "origin", "--delete", "feature/x");
    const refs = await git(repoPath, "for-each-ref", "--format=%(refname)");
    expect(refs).not.toContain("refs/heads/feature/x");
  });

  it("git update-ref directly on the bare repo bypasses the hook (design escape hatch)", async () => {
    const repoPath = join(workDir, "skills");
    const cloneDir = join(workDir, "clone");
    await bootstrapSkillsRepo({ path: repoPath });
    await setupClone(repoPath, cloneDir);
    await git(cloneDir, "push", "origin", "main:refs/heads/feature/x");
    const sha = (await git(repoPath, "rev-parse", "refs/heads/feature/x")).trim();
    // Cogmo's `register` RPC will use exactly this command path to advance
    // `main` after classification. Hooks only fire on `push`, not on
    // `update-ref` against the filesystem.
    await git(repoPath, "update-ref", "refs/heads/main", sha);
    const main = (await git(repoPath, "rev-parse", "refs/heads/main")).trim();
    expect(main).toBe(sha);
  });

  it("rejects a force-push (non-fast-forward) on a feature branch", async () => {
    const repoPath = join(workDir, "skills");
    const cloneDir = join(workDir, "clone");
    await bootstrapSkillsRepo({ path: repoPath });
    await setupClone(repoPath, cloneDir);

    // Initial push of feature branch.
    await git(cloneDir, "push", "origin", "main:refs/heads/feature/x");

    // Build a divergent branch with a different commit and try to force-push.
    await execFileP("bash", [
      "-c",
      `cd "${cloneDir}" && \
         git checkout -b feature-divergent main && \
         git reset --hard HEAD~0 && \
         echo divergent > other.txt && \
         git add other.txt && \
         GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com \
         GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com \
         git commit --amend -m amended`,
    ]);

    const { stderr } = await gitFails(
      cloneDir,
      "push",
      "--force",
      "origin",
      "feature-divergent:refs/heads/feature/x",
    );
    expect(stderr).toMatch(/non-fast-forward/i);
  });
});
