import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGit, withGitAskpass } from "./git-askpass.js";

describe("withGitAskpass", () => {
  it("invokes fn with a helper that prints the PAT to stdout", async () => {
    const captured: string[] = [];
    await withGitAskpass("ghp_secret_xxx", async (env) => {
      const cmd = `${env.GIT_ASKPASS} 'Password'`;
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf8" });
      captured.push(r.stdout);
    });
    expect(captured[0]).toBe("ghp_secret_xxx");
  });

  it("removes the helper directory after fn resolves", async () => {
    let helperDir = "";
    await withGitAskpass("pat", async (env) => {
      helperDir = env.GIT_ASKPASS.replace(/\/askpass\.sh$/, "");
      expect(existsSync(env.GIT_ASKPASS)).toBe(true);
    });
    expect(existsSync(helperDir)).toBe(false);
  });

  it("removes the helper directory even when fn throws", async () => {
    let helperDir = "";
    await expect(
      withGitAskpass("pat", async (env) => {
        helperDir = env.GIT_ASKPASS.replace(/\/askpass\.sh$/, "");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(helperDir)).toBe(false);
  });

  it("creates the helper script with mode 0700 and the secret file with mode 0600", async () => {
    await withGitAskpass("pat", async (env) => {
      const helperMode = statSync(env.GIT_ASKPASS).mode & 0o777;
      const secretPath = env.GIT_ASKPASS.replace(/askpass\.sh$/, "pat");
      const secretMode = statSync(secretPath).mode & 0o777;
      expect(helperMode).toBe(0o700);
      expect(secretMode).toBe(0o600);
    });
  });

  it("survives a PAT containing single quotes (shell-quoting)", async () => {
    let captured = "";
    await withGitAskpass("ghp_with's quotes", async (env) => {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("/bin/sh", ["-c", env.GIT_ASKPASS], { encoding: "utf8" });
      captured = r.stdout;
    });
    expect(captured).toBe("ghp_with's quotes");
  });
});

describe("runGit", () => {
  it("runs `git --version` successfully and returns stdout", async () => {
    await withGitAskpass("dummy", async (env) => {
      const { stdout } = await runGit(["--version"], env);
      expect(stdout).toMatch(/^git version /);
    });
  });

  it("rejects with a descriptive message on non-zero exit", async () => {
    await withGitAskpass("dummy", async (env) => {
      await expect(runGit(["nonexistent-subcommand"], env)).rejects.toThrow(/exited with code/);
    });
  });

  it("passes opts.cwd through to the spawned process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cogmo-runGit-test-"));
    await withGitAskpass("dummy", async (env) => {
      // `git init` inside an empty dir should succeed and create .git
      await runGit(["init", "--quiet"], env, { cwd: dir });
      expect(existsSync(join(dir, ".git"))).toBe(true);
      // sanity: read HEAD
      const head = readFileSync(join(dir, ".git", "HEAD"), "utf8");
      expect(head).toMatch(/^ref: /);
    });
  });
});
