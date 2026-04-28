import { PassThrough, type Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ExecHandle, ExecOptions, TaskContainerHandle } from "../../sandbox/index.js";
import { runCommitAndPush } from "./commit-push.js";

interface FakeExecResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function fakeExec(result: FakeExecResult): ExecHandle {
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

  const exec = vi.fn(async (cmd: ReadonlyArray<string>, opts?: ExecOptions) => {
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
    container: { exec } as unknown as Pick<TaskContainerHandle, "exec">,
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
  GIT_ASKPASS: "/.cogmo-askpass/helper",
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
      signingKeyPath: "/.cogmo-askpass/signing-key",
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
    expect(commitCall?.args).toContain("user.signingkey=/.cogmo-askpass/signing-key");
    expect(commitCall?.args).toContain("gpg.format=ssh");
    expect(commitCall?.args).toContain("user.email=cogmo-bot@noreply");
    expect(commitCall?.args).toContain("user.name=Cogmo Bot".replace('"', ""));
    expect(commitCall?.args).toContain("-S");
    expect(commitCall?.args).toContain("-m");
    expect(commitCall?.args).toContain("test goal");
    expect(commitCall?.workingDir).toBe("/workspace");
    expect(commitCall?.env).toBe(askpassEnv);

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
      signingKeyPath: "/.cogmo-askpass/signing-key",
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
      signingKeyPath: "/.cogmo-askpass/signing-key",
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
      signingKeyPath: "/.cogmo-askpass/signing-key",
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
      signingKeyPath: "/.cogmo-askpass/signing-key",
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
      signingKeyPath: "/.cogmo-askpass/signing-key",
      askpassEnv,
      author,
    });

    for (const call of calls) {
      expect(call.env).toBe(askpassEnv);
      expect(call.workingDir).toBe("/workspace");
    }
  });
});
