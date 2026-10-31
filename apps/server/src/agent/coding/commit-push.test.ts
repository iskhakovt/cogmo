import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { err, ok, type Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ExecExit,
  type ExecFailure,
  type ExecOptions,
  type ExecStreamingHandle,
  type LocalDockerSessionState,
  type SandboxSession,
  unwrapExit,
} from "../../sandbox/index.js";
import { assertKind, expectDefined } from "../../test/assertions.js";
import { fakeExecHandle } from "../../test/coding-fixtures.js";
import { runCommitAndPush, runWipCommit, runWipPush } from "./commit-push.js";

interface FakeExecResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** The transport fails: both streams fail with this error, and so does the exec. */
  transportError?: Error;
}

function fakeExec(result: FakeExecResult): ExecStreamingHandle {
  return fakeExecHandle({ ...result, dispose: vi.fn(async () => {}) });
}

interface RecordedCall {
  args: ReadonlyArray<string>;
  workingDir?: string | undefined;
  env?: Readonly<Record<string, string>> | undefined;
}

/**
 * Build a container whose `exec` returns scripted results in order. Each
 * `script` entry maps a `git <subcommand>` (the second arg) to a result.
 * If a sub-command isn't in the script, the test fails.
 */
function fakeContainer(script: Record<string, FakeExecResult | FakeExecResult[]>) {
  const calls: RecordedCall[] = [];
  const cursors: Record<string, number> = {};

  const execStreaming = vi.fn(async (cmd: ReadonlyArray<string>, opts?: ExecOptions) => {
    calls.push({ args: cmd, workingDir: opts?.workingDir, env: opts?.env });
    if (cmd[0] !== "git") {
      throw new Error(`unexpected exec: ${cmd.join(" ")}`);
    }
    // Choose by the first non-`-c` token (the actual git sub-command).
    const sub = cmd.slice(1).find((a) => !a.startsWith("-c") && a !== "git" && !isFlagValue(a));
    if (sub === undefined) {
      throw new Error(`could not parse subcommand from: ${cmd.join(" ")}`);
    }
    const entry = script[sub];
    if (!entry) {
      throw new Error(`no scripted result for git subcommand: ${sub}`);
    }
    if (Array.isArray(entry)) {
      const idx = cursors[sub] ?? 0;
      cursors[sub] = idx + 1;
      const result = entry[idx];
      if (!result) throw new Error(`script for ${sub} exhausted (index ${idx})`);
      return fakeExec(result);
    }
    return fakeExec(entry);
  });

  return {
    container: { execStreaming } as unknown as Pick<
      SandboxSession<LocalDockerSessionState>,
      "execStreaming"
    >,
    calls,
  };
}

function isFlagValue(s: string): boolean {
  // `-c key=value` produces a "key=value" token after `-c`. Heuristic for
  // the tests' parser: anything containing `=` but not `--` is a config
  // value rather than a subcommand. `commit -S -m` is fine because `-S`
  // and `-m` start with `-`.
  return s.includes("=") || s.startsWith("-");
}

const askpassEnv = Object.freeze({
  GIT_ASKPASS: "/tmp/cogmo-askpass/helper",
  GIT_TERMINAL_PROMPT: "0",
});

const author = { name: "Cogmo Bot", email: "cogmo-bot@noreply" };

describe("runCommitAndPush", () => {
  it("commits + pushes when the working tree is dirty and returns kind=pushed with sha", async () => {
    const { container, calls } = fakeContainer({
      status: { stdout: "M src/foo.ts\n" },
      add: { exitCode: 0 },
      commit: { stdout: "[cogmo/abc 1234567] foo\n", exitCode: 0 },
      push: { stderr: "To origin\n * [new branch]      cogmo/abc -> cogmo/abc\n", exitCode: 0 },
      "rev-parse": { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n", exitCode: 0 },
    });

    const result = await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc12345",
      commitMessage: "test goal",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    expect(result.kind).toBe("pushed");
    if (result.kind === "pushed") {
      expect(result.commitSha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    }

    // Verify the commit invocation used the per-invocation signing config.
    const commitCall = calls.find((c) => c.args.includes("commit"));
    expect(commitCall).toBeDefined();
    expect(commitCall?.args).toContain("user.signingkey=/tmp/cogmo-askpass/signing-key");
    expect(commitCall?.args).toContain("gpg.format=ssh");
    expect(commitCall?.args).toContain("user.email=cogmo-bot@noreply");
    expect(commitCall?.args).toContain("user.name=Cogmo Bot".replace('"', ""));
    expect(commitCall?.args).toContain("-S");
    expect(commitCall?.args).toContain("-m");
    expect(commitCall?.args).toContain("test goal");
    expect(commitCall?.workingDir).toBe("/workspace");
    expect(commitCall?.env).toBe(askpassEnv);

    const pushCall = calls.find((c) => c.args.includes("push"));
    expect(pushCall?.args).toEqual([
      "git",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "push",
      "origin",
      "cogmo/abc12345",
    ]);
  });

  it("skips the commit when the working tree is clean and returns kind=nothing_to_commit", async () => {
    const { container, calls } = fakeContainer({
      status: { stdout: "" },
      push: { stderr: "Everything up-to-date\n", exitCode: 0 },
    });

    const result = await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      commitMessage: "no-op",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    expect(result.kind).toBe("nothing_to_commit");
    expect(calls.find((c) => c.args.includes("commit"))).toBeUndefined();
    expect(calls.find((c) => c.args.includes("add"))).toBeUndefined();
  });

  it("returns kind=branch_conflict when the push is rejected", async () => {
    const { container } = fakeContainer({
      status: { stdout: "" },
      push: {
        stderr:
          "To https://github.com/example/repo.git\n ! [rejected]        cogmo/abc -> cogmo/abc (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/example/repo.git'\n",
        exitCode: 1,
      },
    });

    const result = await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      commitMessage: "x",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    expect(result.kind).toBe("branch_conflict");
    if (result.kind === "branch_conflict") {
      expect(result.output).toMatch(/non-fast-forward/);
    }
  });

  it("returns kind=auth_failed when git reports authentication failure", async () => {
    const { container } = fakeContainer({
      status: { stdout: "M x\n" },
      add: { exitCode: 0 },
      commit: { exitCode: 0 },
      push: {
        stderr: "remote: Authentication failed for 'https://github.com/...'\n",
        exitCode: 128,
      },
    });

    const result = await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      commitMessage: "x",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    expect(result.kind).toBe("auth_failed");
  });

  it("returns kind=failed for a generic git error", async () => {
    const { container } = fakeContainer({
      status: { stdout: "M y\n" },
      add: { exitCode: 0 },
      commit: { stderr: "fatal: cannot run gpg: No such file\n", exitCode: 1 },
    });

    const result = await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      commitMessage: "x",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.output).toMatch(/cannot run gpg/);
    }
  });

  it("throws a transport failure without leaving a stream reader's rejection unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const transportError = new Error("hijacked socket reset");
      const { container } = fakeContainer({ status: { transportError } });
      await expect(
        runCommitAndPush({
          container,
          worktreeDir: "/workspace",
          branch: "cogmo/abc",
          commitMessage: "goal",
          signingKeyPath: "/tmp/cogmo-askpass/signing-key",
          askpassEnv: {},
          author: { name: "a", email: "a@example.com" },
        }),
      ).rejects.toBe(transportError);
      // Node reports an unhandled rejection once the microtask queue drains.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("threads askpass env into every git invocation", async () => {
    const { container, calls } = fakeContainer({
      status: { stdout: "" },
      push: { exitCode: 0 },
    });

    await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      commitMessage: "x",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    for (const call of calls) {
      expect(call.env).toBe(askpassEnv);
      expect(call.workingDir).toBe("/workspace");
    }
  });

  it("runs every git invocation with git's background maintenance disabled", async () => {
    // Steps 2 and 3 spawn a detached `git maintenance run --auto` that keeps
    // writing into /workspace — the host worktree, through the bind mount —
    // after the command returns, racing the delete teardown does later.
    const { container, calls } = fakeContainer({
      status: { stdout: "M src/foo.ts\n" },
      add: { exitCode: 0 },
      commit: { stdout: "[cogmo/abc 1234567] foo\n", exitCode: 0 },
      push: { exitCode: 0 },
      "rev-parse": { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n", exitCode: 0 },
    });

    await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc12345",
      commitMessage: "test goal",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args.slice(0, 5)).toEqual([
        "git",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
      ]);
    }
  });

  it("leaves the caller's env untouched, so container config pairs survive", async () => {
    // The container's ambient environment isn't visible from the host, so
    // numbering our own GIT_CONFIG_* pairs would shadow index 0 of whatever it
    // already declares — `safe.directory` being the one that matters, since
    // losing it makes git refuse the bind-mounted worktree. Carrying the
    // settings on the argv leaves the env exactly as the caller built it.
    const envWithConfig = Object.freeze({
      ...askpassEnv,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/workspace",
    });
    const { container, calls } = fakeContainer({
      status: { stdout: "M src/foo.ts\n" },
      add: { exitCode: 0 },
      commit: { stdout: "[cogmo/abc 1234567] foo\n", exitCode: 0 },
      push: { exitCode: 0 },
      "rev-parse": { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n", exitCode: 0 },
    });

    await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc12345",
      commitMessage: "test goal",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv: envWithConfig,
      author,
    });

    for (const call of calls) {
      expect(call.env).toEqual(envWithConfig);
      expect(call.args).toContain("maintenance.auto=false");
    }
  });

  it("returns kind=failed when `git status` itself errors (worktree corrupt / not a git dir)", async () => {
    // The very first git command sets the floor — if `status` fails, the
    // function must short-circuit with `failed` instead of trying to add
    // + commit against a broken tree.
    const { container, calls } = fakeContainer({
      status: { stderr: "fatal: not a git repository\n", exitCode: 128 },
    });

    const result = await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      commitMessage: "x",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.output).toMatch(/not a git repository/);
    }
    // Did NOT proceed to add / commit / push.
    expect(calls.find((c) => c.args.includes("add"))).toBeUndefined();
    expect(calls.find((c) => c.args.includes("commit"))).toBeUndefined();
    expect(calls.find((c) => c.args.includes("push"))).toBeUndefined();
  });

  it("returns kind=failed when `git add` errors (e.g. permission denied)", async () => {
    // status reports dirty, then add fails. Without this branch the
    // function would proceed to commit a partially-staged tree.
    const { container, calls } = fakeContainer({
      status: { stdout: "M src/foo.ts\n" },
      add: { stderr: "fatal: pathspec error\n", exitCode: 128 },
    });

    const result = await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      commitMessage: "x",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.output).toMatch(/pathspec/);
    }
    expect(calls.find((c) => c.args.includes("commit"))).toBeUndefined();
    expect(calls.find((c) => c.args.includes("push"))).toBeUndefined();
  });

  it("truncates oversized git output to the last 8 KiB with a marker", async () => {
    // 12 KiB stderr — exceeds the 8 KiB cap. Push exits non-zero so
    // the failure path returns `output`, which is what the orchestrator
    // persists into `failure_reason` and the Inngest event payload.
    const longTail = "trailing diagnostic line\n".repeat(700);
    const { container } = fakeContainer({
      status: { stdout: "" },
      push: {
        stderr: `${"x".repeat(4 * 1024)}\nfatal: a real error message\n${longTail}`,
        exitCode: 1,
      },
    });

    const result = await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      commitMessage: "x",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    expect(result.kind).toBe("failed");
    expect(result.output.length).toBeLessThanOrEqual(8 * 1024 + 64);
    expect(result.output).toContain("[cogmo: output truncated to last 8 KiB]");
    // The cap-from-the-end preserves the most-recent trailing lines.
    expect(result.output).toContain("trailing diagnostic line");
  });

  it("redacts URL credentials and access tokens from git output", async () => {
    const pat = `ghp_${"a1".repeat(18)}`;
    const { container } = fakeContainer({
      status: { stdout: "" },
      push: {
        stderr: `fatal: unable to access 'https://x-access-token:${pat}@github.com/o/r.git/': The requested URL returned error: 500\nMY_TOKEN_${pat}\n`,
        exitCode: 128,
      },
    });

    const result = await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      commitMessage: "x",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    expect(result.kind).toBe("failed");
    expect(result.output).not.toContain(pat);
    expect(result.output).toContain("'https://REDACTED@github.com/o/r.git/'");
    expect(result.output).toContain("MY_TOKEN_ghp_REDACTED");
  });

  it("redacts a token the 8 KiB tail cut runs through", async () => {
    const pat = `ghp_${"b2".repeat(18)}`;
    // The kept tail starts 10 characters into the token.
    const tail = `\n${"y".repeat(8 * 1024 - (pat.length - 10) - 1)}`;
    const { container } = fakeContainer({
      status: { stdout: "" },
      push: { stderr: `${"x".repeat(1024)}\n${pat}${tail}`, exitCode: 1 },
    });

    const result = await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      commitMessage: "x",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    expect(result.output).toContain("[cogmo: output truncated to last 8 KiB]");
    expect(result.output).not.toContain(pat.slice(10));
  });
});

/**
 * A container stand-in that runs each exec on the host, with `/workspace`
 * mapped to `root` in the working directory and the argv: real git against a
 * real clone, for the salvage's argv.
 */
function hostSession(root: string): Pick<SandboxSession, "execStreaming"> {
  return {
    execStreaming: async (cmd, opts) => {
      const [file, ...args] = cmd;
      if (file === undefined) throw new Error("empty argv");
      const child = spawn(
        file,
        args.map((a) => (a === "/workspace" ? root : a)),
        {
          cwd: opts?.workingDir === "/workspace" ? root : opts?.workingDir,
          env: { ...process.env, ...opts?.env },
        },
      );
      const exited = new Promise<Result<ExecExit, ExecFailure>>((resolve) => {
        child.on("error", (error) => resolve(err({ kind: "transport_failed", error })));
        child.on("close", (code) => resolve(ok({ exitCode: code ?? 1 })));
      });
      return {
        stdout: child.stdout,
        stderr: child.stderr,
        exited,
        wait: () => exited.then(unwrapExit),
        dispose: async () => {
          child.kill();
        },
      };
    },
  };
}

describe("the WIP salvage against a real clone", () => {
  const execFileP = promisify(execFile);
  const branch = "cogmo/abc12345";
  const taskId = "019d0000-0000-7000-8000-000000000001";
  const wipRef = `refs/cogmo-wip/${taskId}`;
  // A local remote takes no credential; the env only marks the push as the
  // one exec that gets one.
  const env = Object.freeze({ GIT_TERMINAL_PROMPT: "0" });
  let dir: string;
  let bare: string;
  let clone: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cogmo-wip-salvage-"));
    bare = join(dir, "bare.git");
    clone = join(dir, "clone");
    await execFileP("git", ["init", "--bare", bare]);
    await execFileP("git", ["init", "--initial-branch=main", clone]);
    writeFileSync(join(clone, "README.md"), "hello\n");
    await execFileP("git", ["-C", clone, "add", "."]);
    await execFileP("git", [
      "-C",
      clone,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "init",
    ]);
    await execFileP("git", ["-C", clone, "checkout", "-b", branch]);
    await execFileP("git", ["-C", clone, "remote", "add", "origin", bare]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function commit() {
    return runWipCommit({ container: hostSession(clone), worktreeDir: "/workspace", taskId });
  }

  function push(sha: string) {
    return runWipPush({
      container: hostSession(clone),
      worktreeDir: "/workspace",
      scratchGitDir: join(dir, "scratch.git"),
      remoteUrl: bare,
      taskId,
      sha,
      askpassEnv: env,
    });
  }

  async function remoteRef(ref: string): Promise<string | null> {
    try {
      const { stdout } = await execFileP("git", ["--git-dir", bare, "rev-parse", "--verify", ref]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async function head(): Promise<string> {
    const { stdout } = await execFileP("git", ["-C", clone, "rev-parse", "HEAD"]);
    return stdout.trim();
  }

  it("commits a dirty tree as wip, then pushes it to the per-task ref", async () => {
    writeFileSync(join(clone, "in-progress.ts"), "// claude was here\n");

    const committed = await commit();
    assertKind(committed, "needs_push");
    expect(committed.sha).toBe(await head());
    const pushed = await push(committed.sha);

    expect(pushed).toEqual({ kind: "pushed", wipRef, sha: committed.sha });
    expect(await remoteRef(wipRef)).toBe(committed.sha);
    const { stdout } = await execFileP("git", [
      "--git-dir",
      bare,
      "log",
      "-1",
      "--format=%s",
      wipRef,
    ]);
    expect(stdout.trim()).toBe(`wip: ${taskId}`);
  });

  it("reports a clean tree whose branch the remote-tracking ref already records", async () => {
    await execFileP("git", ["-C", clone, "push", "origin", branch]);

    expect(await commit()).toEqual({ kind: "clean" });
  });

  it("reports a never-pushed branch cut from a pushed tip as clean", async () => {
    // The plan-failure shape: the task branch exists only locally, at the
    // tip the clone came with, so nothing on it is missing from the remote.
    await execFileP("git", ["-C", clone, "push", "origin", "main"]);

    expect(await commit()).toEqual({ kind: "clean" });
  });

  it("reports a clean tree with commits no remote-tracking ref holds as needing a push, without a commit", async () => {
    const before = await head();

    expect(await commit()).toEqual({ kind: "needs_push", sha: before });
    expect(await head()).toBe(before);
  });

  it("lands the same commit on the same ref when re-run after a push", async () => {
    writeFileSync(join(clone, "in-progress.ts"), "// claude was here\n");
    const first = await commit();
    assertKind(first, "needs_push");
    await push(first.sha);

    const second = await commit();
    assertKind(second, "needs_push");
    expect(second.sha).toBe(first.sha);
    expect(await push(second.sha)).toEqual({ kind: "pushed", wipRef, sha: first.sha });
  });

  it("runs none of the tree's hooks or its fsmonitor", async () => {
    const marker = join(dir, "ran");
    const hook = `#!/bin/sh\necho "$0" >> '${marker}'\nexit 0\n`;
    for (const name of [
      "pre-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "pre-push",
    ]) {
      writeFileSync(join(clone, ".git", "hooks", name), hook, { mode: 0o755 });
    }
    writeFileSync(join(dir, "fsmonitor"), hook, { mode: 0o755 });
    await execFileP("git", ["-C", clone, "config", "core.fsmonitor", join(dir, "fsmonitor")]);
    writeFileSync(join(clone, "in-progress.ts"), "// claude was here\n");

    const committed = await commit();
    assertKind(committed, "needs_push");
    assertKind(await push(committed.sha), "pushed");

    expect(existsSync(marker)).toBe(false);
  });

  it("pushes to the given URL whatever the tree's remotes and rewrites say", async () => {
    await execFileP("git", ["-C", clone, "remote", "set-url", "origin", join(dir, "missing.git")]);
    await execFileP("git", [
      "-C",
      clone,
      "config",
      `url.${join(dir, "elsewhere.git")}.insteadOf`,
      bare,
    ]);
    const committed = await commit();
    assertKind(committed, "needs_push");

    expect(await push(committed.sha)).toEqual({ kind: "pushed", wipRef, sha: committed.sha });
    expect(await remoteRef(wipRef)).toBe(committed.sha);
  });

  it("refuses to push a HEAD other than the one committed", async () => {
    const result = await push("0123456789012345678901234567890123456789");

    assertKind(result, "failed");
    expect(result.stage).toBe("fetch");
    expect(result.output).toMatch(/HEAD moved/);
    expect(await remoteRef(wipRef)).toBeNull();
  });

  it("reports the failing stage when the push is refused", async () => {
    const result = await runWipPush({
      container: hostSession(clone),
      worktreeDir: "/workspace",
      scratchGitDir: join(dir, "scratch.git"),
      remoteUrl: join(dir, "missing.git"),
      taskId,
      sha: await head(),
      askpassEnv: env,
    });

    assertKind(result, "failed");
    expect(result.stage).toBe("push");
    expect(result.output).toMatch(/missing\.git/);
  });

  it("never lazy-fetches in the tree, whatever the tree's promisor and ssh settings", async () => {
    // A tree posing as a partial clone, HEAD on a commit whose blob is gone:
    // an upload-pack that lazy-fetches runs the tree's `core.sshCommand` to
    // fetch it, while the PAT is readable. `GIT_NO_LAZY_FETCH=0` in the
    // ambient env stands in for a git that lazy-fetches by default.
    writeFileSync(join(clone, "secret.txt"), "gone\n");
    await execFileP("git", ["-C", clone, "add", "secret.txt"]);
    await execFileP("git", [
      "-C",
      clone,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "add",
    ]);
    const { stdout: blob } = await execFileP("git", ["-C", clone, "rev-parse", "HEAD:secret.txt"]);
    const id = blob.trim();
    rmSync(join(clone, ".git", "objects", id.slice(0, 2), id.slice(2)));
    const marker = join(dir, "ssh-ran");
    writeFileSync(join(dir, "ssh"), `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`, {
      mode: 0o755,
    });
    for (const [key, value] of [
      ["core.repositoryformatversion", "1"],
      ["extensions.partialClone", "promisor"],
      ["remote.promisor.url", "ssh://example.invalid/x.git"],
      ["remote.promisor.promisor", "true"],
      ["core.sshCommand", join(dir, "ssh")],
    ] as const) {
      await execFileP("git", ["-C", clone, "config", key, value]);
    }
    vi.stubEnv("GIT_NO_LAZY_FETCH", "0");
    try {
      const result = await push(await head());

      assertKind(result, "failed");
      expect(result.stage).toBe("fetch");
      expect(existsSync(marker)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("runWipPush", () => {
  it("reports a failed scratch-repo init", async () => {
    const { container, calls } = fakeContainer({
      init: { exitCode: 1, stderr: "fatal: cannot mkdir /tmp/cogmo-wip.git\n" },
    });

    const result = await runWipPush({
      container,
      worktreeDir: "/workspace",
      scratchGitDir: "/tmp/cogmo-wip.git",
      remoteUrl: "https://github.com/user/cogmo.git",
      taskId: "t",
      sha: "deadbeef",
      askpassEnv,
    });

    expect(result).toEqual({
      kind: "failed",
      stage: "init",
      output: expect.stringContaining("cannot mkdir"),
    });
    expect(calls).toHaveLength(1);
  });

  it("reports a failed fetch from the tree, and pushes nothing", async () => {
    const { container, calls } = fakeContainer({
      init: {},
      fetch: { exitCode: 128, stderr: "fatal: protocol error: bad pack header\n" },
    });

    const result = await runWipPush({
      container,
      worktreeDir: "/workspace",
      scratchGitDir: "/tmp/cogmo-wip.git",
      remoteUrl: "https://github.com/user/cogmo.git",
      taskId: "t",
      sha: "deadbeef",
      askpassEnv,
    });

    expect(result).toEqual({
      kind: "failed",
      stage: "fetch",
      output: expect.stringContaining("bad pack header"),
    });
    expect(calls.map((c) => c.args.includes("push"))).toEqual([false, false]);
  });

  it("gives the askpass env to the push alone, and every exec the salvage config", async () => {
    const { container, calls } = fakeContainer({
      init: {},
      fetch: {},
      "rev-parse": { stdout: "deadbeef\n" },
      push: {},
    });

    await runWipPush({
      container,
      worktreeDir: "/workspace",
      scratchGitDir: "/tmp/cogmo-wip.git",
      remoteUrl: "https://github.com/user/cogmo.git",
      taskId: "t",
      sha: "deadbeef",
      askpassEnv,
    });

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.args).toEqual(
        expect.arrayContaining([
          "maintenance.auto=false",
          "core.hooksPath=/dev/null",
          "core.fsmonitor=false",
          "credential.helper=",
          "--git-dir=/tmp/cogmo-wip.git",
        ]),
      );
      const isPush = call.args.includes("push");
      expect(call.env?.GIT_ASKPASS).toBe(isPush ? askpassEnv.GIT_ASKPASS : undefined);
    }
    const fetch = expectDefined(
      calls.find((c) => c.args.includes("fetch")),
      "fetch exec",
    );
    expect(fetch.env).toEqual({ GIT_NO_LAZY_FETCH: "1" });
    expect(fetch.args).toEqual(
      expect.arrayContaining([
        "--no-recurse-submodules",
        "--upload-pack=env GIT_NO_LAZY_FETCH=1 git -c protocol.ext.allow=never -c protocol.ssh.allow=never -c protocol.file.allow=never upload-pack",
      ]),
    );
  });
});
