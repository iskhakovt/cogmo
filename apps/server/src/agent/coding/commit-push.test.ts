import { PassThrough, type Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  ExecOptions,
  ExecStreamingHandle,
  LocalDockerSessionState,
  SandboxSession,
} from "../../sandbox/index.js";
import { runCommitAndPush } from "./commit-push.js";

interface FakeExecResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function fakeExec(result: FakeExecResult): ExecStreamingHandle {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  stdout.end();
  stderr.end();
  return {
    stdout: stdout as Readable,
    stderr: stderr as Readable,
    wait: vi.fn(async () => ({ exitCode: result.exitCode ?? 0 })),
    dispose: vi.fn(async () => {}),
  };
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
    expect(commitCall?.env).toMatchObject(askpassEnv);

    const pushCall = calls.find((c) => c.args.includes("push"));
    expect(pushCall?.args).toEqual(["git", "push", "origin", "cogmo/abc12345"]);
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
      expect(call.env).toMatchObject(askpassEnv);
      expect(call.workingDir).toBe("/workspace");
    }
  });

  it("runs every git invocation with git's background maintenance disabled", async () => {
    // `git commit` and `git push` each spawn a detached `git maintenance run
    // --auto` that goes on writing inside `.git/` after the foreground
    // command exits. On the bind-mount backend `worktreeDir` is the host
    // working tree teardown deletes once the task settles, so the detached
    // writer repopulates directories mid-delete and leaves a half-deleted
    // clone at a path that is stable per task — which then blocks the next
    // `allocateWorktree` there. `GIT_CONFIG_*` outranks the repo-local
    // config the sandbox image ships, so the suppression always wins.
    const { container, calls } = fakeContainer({
      status: { stdout: "M src/foo.ts\n" },
      add: { exitCode: 0 },
      commit: { exitCode: 0 },
      push: { exitCode: 0 },
      "rev-parse": { stdout: "deadbeef\n", exitCode: 0 },
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

    expect(result.kind).toBe("pushed");
    // Covers status, add, commit, push, rev-parse.
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.env).toMatchObject({
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "maintenance.auto",
        GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_KEY_1: "gc.auto",
        GIT_CONFIG_VALUE_1: "0",
      });
    }
  });

  it("numbers its git config after pairs the askpass env already declares", async () => {
    // A caller's env record can carry config pairs of its own — the
    // `safe.directory` entry in-container git needs when the mount's owner
    // uid doesn't match the exec user, say. Numbering from 0 would shadow
    // them; ours start at the declared count instead.
    const envWithConfig = Object.freeze({
      ...askpassEnv,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/workspace",
    });
    const { container, calls } = fakeContainer({
      status: { stdout: "M src/foo.ts\n" },
      add: { exitCode: 0 },
      commit: { exitCode: 0 },
      push: { exitCode: 0 },
      "rev-parse": { stdout: "deadbeef\n", exitCode: 0 },
    });

    await runCommitAndPush({
      container,
      worktreeDir: "/workspace",
      branch: "cogmo/abc",
      commitMessage: "x",
      signingKeyPath: "/tmp/cogmo-askpass/signing-key",
      askpassEnv: envWithConfig,
      author,
    });

    for (const call of calls) {
      expect(call.env).toMatchObject({
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "/workspace",
        GIT_CONFIG_KEY_1: "maintenance.auto",
        GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "gc.auto",
        GIT_CONFIG_VALUE_2: "0",
      });
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
});
