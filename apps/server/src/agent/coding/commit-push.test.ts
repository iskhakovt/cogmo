import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { assertKind } from "../../test/assertions.js";
import { fakeExecHandle } from "../../test/coding-fixtures.js";
import { runCommitAndPush, runWipSalvage } from "./commit-push.js";

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
 * mapped to `root`: real git against a real clone, for the salvage's argv.
 */
function hostSession(root: string): Pick<SandboxSession, "execStreaming"> {
  return {
    execStreaming: async (cmd, opts) => {
      const [file, ...args] = cmd;
      if (file === undefined) throw new Error("empty argv");
      const child = spawn(file, args, {
        cwd: opts?.workingDir === "/workspace" ? root : opts?.workingDir,
        env: { ...process.env, ...opts?.env },
      });
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

describe("runWipSalvage against a real clone", () => {
  const execFileP = promisify(execFile);
  const branch = "cogmo/abc12345";
  const taskId = "019d0000-0000-7000-8000-000000000001";
  const wipRef = `refs/cogmo-wip/${taskId}`;
  // A file:// remote takes no credential; the env only marks the push as the
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

  function salvage(askpassEnv: Readonly<Record<string, string>> | undefined) {
    return runWipSalvage({
      container: hostSession(clone),
      worktreeDir: "/workspace",
      branch,
      taskId,
      askpassEnv,
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

  it("commits a dirty tree as wip and pushes it to the per-task ref", async () => {
    writeFileSync(join(clone, "in-progress.ts"), "// claude was here\n");

    const result = await salvage(env);

    assertKind(result, "pushed");
    expect(result.wipRef).toBe(wipRef);
    expect(await remoteRef(wipRef)).toBe(result.sha);
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

    expect(await salvage(env)).toEqual({ kind: "clean" });
    expect(await remoteRef(wipRef)).toBeNull();
  });

  it("pushes a clean tree whose branch was never pushed, without a new commit", async () => {
    const { stdout: head } = await execFileP("git", ["-C", clone, "rev-parse", "HEAD"]);

    const result = await salvage(env);

    assertKind(result, "pushed");
    expect(result.sha).toBe(head.trim());
  });

  it("lands the same commit on the same ref when re-run after a push", async () => {
    writeFileSync(join(clone, "in-progress.ts"), "// claude was here\n");
    const first = await salvage(env);
    const second = await salvage(env);

    assertKind(first, "pushed");
    assertKind(second, "pushed");
    expect(second.sha).toBe(first.sha);
    expect(await remoteRef(wipRef)).toBe(first.sha);
  });

  it("is not blocked by hooks in the tree", async () => {
    for (const hook of ["pre-commit", "commit-msg", "pre-push"]) {
      writeFileSync(join(clone, ".git", "hooks", hook), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
    writeFileSync(join(clone, "in-progress.ts"), "// claude was here\n");

    const result = await salvage(env);

    assertKind(result, "pushed");
    expect(await remoteRef(wipRef)).toBe(result.sha);
  });

  it("commits nothing when there is no credential to push with", async () => {
    writeFileSync(join(clone, "in-progress.ts"), "// claude was here\n");

    expect(await salvage(undefined)).toEqual({ kind: "no_credentials" });
    const { stdout } = await execFileP("git", ["-C", clone, "status", "--porcelain"]);
    expect(stdout).toContain("in-progress.ts");
  });

  it("reports the failing stage when the push is refused", async () => {
    await execFileP("git", ["-C", clone, "remote", "set-url", "origin", join(dir, "missing.git")]);

    const result = await salvage(env);

    assertKind(result, "failed");
    expect(result.stage).toBe("push");
    expect(result.output).toMatch(/missing\.git/);
  });
});

describe("runWipSalvage", () => {
  it("gives the askpass env to the push alone and keeps maintenance off on every exec", async () => {
    const { container, calls } = fakeContainer({
      status: { stdout: "M src/foo.ts\n" },
      add: {},
      commit: {},
      "rev-parse": { stdout: "deadbeef\n" },
      push: {},
    });

    await runWipSalvage({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      taskId: "t",
      askpassEnv,
    });

    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.args).toEqual(expect.arrayContaining(["maintenance.auto=false", "gc.auto=0"]));
      const isPush = call.args.includes("push");
      expect(call.env?.GIT_ASKPASS).toBe(isPush ? askpassEnv.GIT_ASKPASS : undefined);
    }
  });
});
