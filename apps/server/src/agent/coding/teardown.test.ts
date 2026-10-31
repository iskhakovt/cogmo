import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { CONTAINER_ASKPASS_DIR } from "../../sandbox/askpass.js";
import type {
  ExecOptions,
  ExecStreamingHandle,
  SandboxClient,
  SandboxSession,
  SessionSpec,
} from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import { type GitHubIdentity, serializeGitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { expectDefined } from "../../test/assertions.js";
import { codingRepoRow, type FakeExecScript, fakeExecHandle } from "../../test/coding-fixtures.js";
import { safeTeardownWorktree, teardownWorktree } from "./teardown.js";
import { allocateWorktree } from "./worktree.js";

/** Every host child process spawned while the module under test runs. */
const hostSpawns = vi.hoisted(
  () => [] as Array<{ file: string; args: ReadonlyArray<string>; cwd: string | undefined }>,
);

// A pass-through recorder: every caller still gets the real child process,
// and the list says what the host ran and where.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify: promisifyFn } = await import("node:util");
  const record = (file: unknown, args: unknown, options: unknown): void => {
    hostSpawns.push({
      file: String(file),
      args: Array.isArray(args) ? args.map(String) : [],
      cwd:
        typeof options === "object" && options !== null && "cwd" in options
          ? String(options.cwd)
          : undefined,
    });
  };
  const execFileAsync = promisifyFn(actual.execFile);
  function execFile(...params: unknown[]): unknown {
    record(params[0], params[1], params[2]);
    return Reflect.apply(actual.execFile, undefined, params);
  }
  Object.defineProperty(execFile, promisifyFn.custom, {
    value: (...params: unknown[]): unknown => {
      record(params[0], params[1], params[2]);
      return Reflect.apply(execFileAsync, undefined, params);
    },
  });
  function spawn(...params: unknown[]): unknown {
    record(params[0], params[1], params[2]);
    return Reflect.apply(actual.spawn, undefined, params);
  }
  return { ...actual, execFile, spawn };
});

const execFileP = promisify(execFile);

const IDENTITY: GitHubIdentity = {
  pat: "ghp_test_token_unused",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nstub\n-----END OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA stub",
  login: "cogmo-bot",
  id: "1",
};

const LIMITS: ResourceLimits = { cpus: 1, memory_bytes: 512 * 1024 * 1024, pids: 256 };
const IMAGE = "cogmo-devbase:test";
const SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

let baseDir: string;
let repoPath: string;
let askpassBaseDir: string;

beforeEach(async () => {
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-teardown-test-"));
  repoPath = join(baseDir, "repo");
  askpassBaseDir = join(baseDir, "askpass");
  await execFileP("git", ["init", "--initial-branch=main", repoPath]);
  await execFileP("git", ["-C", repoPath, "config", "user.email", "t@t"]);
  await execFileP("git", ["-C", repoPath, "config", "user.name", "t"]);
  await execFileP("git", ["-C", repoPath, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  await execFileP("git", ["-C", repoPath, "add", "."]);
  await execFileP("git", ["-C", repoPath, "commit", "-m", "init"]);
});

afterAll(() => {
  if (baseDir) rmSync(baseDir, { recursive: true, force: true });
});

function uniqueTaskId(): string {
  return `019d0000-0000-7000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
}

/** A standalone clone at a fresh path, as `allocate-worktree` leaves it. */
async function allocatedWorktree(
  taskId: string,
): Promise<{ worktreePath: string; branch: string }> {
  const branch = `cogmo/${taskId.slice(-8)}`;
  const worktreePath = join(baseDir, "worktrees", taskId.slice(-8));
  await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: join(baseDir, "remote") });
  return { worktreePath, branch };
}

/** Host `git` processes that ran inside `dir`: as their cwd, or named by `-C` and friends. */
function hostGitInside(dir: string): ReadonlyArray<string> {
  const inside = (p: string | undefined): boolean =>
    p !== undefined && (p === dir || p.startsWith(`${dir}${sep}`) || p.includes(`=${dir}`));
  return hostSpawns
    .filter((c) => c.file === "git" && (inside(c.cwd) || c.args.some(inside)))
    .map((c) => `git ${c.args.join(" ")}`);
}

interface RecordedExec {
  cmd: ReadonlyArray<string>;
  workingDir: string | undefined;
  env: Readonly<Record<string, string>> | undefined;
}

/** The git sub-command of an exec argv, past the leading `-c key=value` pairs. */
function subcommandOf(cmd: ReadonlyArray<string>): string | undefined {
  for (let i = 1; i < cmd.length; i++) {
    const arg = cmd[i];
    if (arg === "-c") {
      i++;
      continue;
    }
    return arg;
  }
  return undefined;
}

/**
 * The sandbox teardown salvages in. `create` hands out a session whose
 * execs answer from `script` by git sub-command (an array answers in turn);
 * `calls` records the client calls in order.
 */
function salvageSandbox(
  script: Record<string, FakeExecScript | FakeExecScript[]>,
  opts: { createFails?: Error } = {},
) {
  const calls: string[] = [];
  const specs: SessionSpec[] = [];
  const execs: RecordedExec[] = [];
  const cursors: Record<string, number> = {};
  const execStreaming = vi.fn(
    async (cmd: ReadonlyArray<string>, o?: ExecOptions): Promise<ExecStreamingHandle> => {
      calls.push(`exec:${subcommandOf(cmd) ?? "?"}`);
      execs.push({ cmd, workingDir: o?.workingDir, env: o?.env });
      const sub = subcommandOf(cmd);
      const entry = sub === undefined ? undefined : script[sub];
      if (entry === undefined) throw new Error(`no scripted result for: ${cmd.join(" ")}`);
      if (!Array.isArray(entry)) return fakeExecHandle(entry);
      const idx = cursors[sub ?? ""] ?? 0;
      cursors[sub ?? ""] = idx + 1;
      const next = entry[idx];
      if (next === undefined) throw new Error(`script for ${sub} exhausted`);
      return fakeExecHandle(next);
    },
  );
  const session: SandboxSession = {
    state: { type: "local-docker", taskId: "t", containerRowId: "row", dockerId: "docker" },
    execStreaming,
    exec: vi.fn(),
  };
  const sandbox: Pick<SandboxClient, "ensureImagePresent" | "create" | "deleteByTaskId"> = {
    ensureImagePresent: vi.fn(async () => {
      calls.push("ensureImagePresent");
    }),
    create: vi.fn(async (spec: SessionSpec) => {
      calls.push("create");
      specs.push(spec);
      if (opts.createFails) throw opts.createFails;
      return session;
    }),
    deleteByTaskId: vi.fn(async () => {
      calls.push("deleteByTaskId");
    }),
  };
  return { sandbox, calls, specs, execs };
}

const DIRTY_SCRIPT = {
  status: { stdout: "?? in-progress.ts\n" },
  add: {},
  commit: { stdout: "[cogmo/x 1234567] wip\n" },
  "rev-parse": { stdout: `${SHA}\n` },
  push: { stderr: "To origin\n" },
} satisfies Record<string, FakeExecScript>;

describe("teardownWorktree", () => {
  it("runs no host git inside the worktree", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox } = salvageSandbox(DIRTY_SCRIPT);

    hostSpawns.length = 0;
    await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: IDENTITY,
      sandbox,
      image: IMAGE,
      resourceLimits: LIMITS,
      askpassBaseDir,
    });

    expect(hostGitInside(worktreePath)).toEqual([]);
  });

  it("salvages a dirty worktree in a fresh task container with the askpass mount, then deletes it", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox, calls, specs, execs } = salvageSandbox(DIRTY_SCRIPT);

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: IDENTITY,
      sandbox,
      image: IMAGE,
      resourceLimits: LIMITS,
      askpassBaseDir,
    });

    expect(result).toEqual({
      kind: "wip_pushed_and_removed",
      wipRef: `refs/cogmo-wip/${taskId}`,
      sha: SHA,
    });
    // The task's own containers go first, so no process the session left
    // running shares the tree or sees the credential.
    expect(calls).toEqual([
      "deleteByTaskId",
      "ensureImagePresent",
      "create",
      "exec:status",
      "exec:add",
      "exec:commit",
      "exec:rev-parse",
      "exec:push",
      "deleteByTaskId",
    ]);
    const spec = expectDefined(specs[0], "salvage spec");
    expect(spec).toMatchObject({
      taskId,
      image: IMAGE,
      resourceLimits: LIMITS,
      worktree: { type: "host-path", hostPath: worktreePath },
      askpass: { hostDir: join(askpassBaseDir, taskId), containerDir: CONTAINER_ASKPASS_DIR },
    });
    // No Claude token and no home volume: the container runs only git.
    expect(spec.env).toBeUndefined();
    expect(spec.homeVolume).toBeUndefined();

    const push = expectDefined(
      execs.find((e) => subcommandOf(e.cmd) === "push"),
      "push exec",
    );
    expect(push.workingDir).toBe("/workspace");
    expect(push.env).toMatchObject({
      GIT_ASKPASS: `${CONTAINER_ASKPASS_DIR}/helper`,
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(push.cmd).toEqual(
      expect.arrayContaining(["--force", "--no-verify", "origin", `HEAD:refs/cogmo-wip/${taskId}`]),
    );
    // Only the push sees the credential.
    for (const e of execs.filter((x) => subcommandOf(x.cmd) !== "push")) {
      expect(e.env?.GIT_ASKPASS).toBeUndefined();
    }
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(askpassBaseDir, taskId))).toBe(false);
  });

  it("keeps the worktree and runs no host git when no container can be created", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox, calls } = salvageSandbox(DIRTY_SCRIPT, {
      createFails: new Error("connect ENOENT /var/run/docker.sock"),
    });

    hostSpawns.length = 0;
    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: IDENTITY,
      sandbox,
      image: IMAGE,
      resourceLimits: LIMITS,
      askpassBaseDir,
    });

    expect(result).toEqual({
      kind: "salvage_unavailable_kept",
      reason: expect.stringContaining("docker.sock"),
    });
    expect(hostGitInside(worktreePath)).toEqual([]);
    expect(existsSync(join(worktreePath, "in-progress.ts"))).toBe(true);
    // The askpass dir provisioned for the container is gone with it.
    expect(calls.at(-1)).toBe("deleteByTaskId");
    expect(existsSync(join(askpassBaseDir, taskId))).toBe(false);
  });

  it("keeps the worktree when the container dies mid-salvage", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox } = salvageSandbox({
      ...DIRTY_SCRIPT,
      add: { transportError: new Error("container not running") },
    });

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: IDENTITY,
      sandbox,
      image: IMAGE,
      resourceLimits: LIMITS,
      askpassBaseDir,
    });

    expect(result).toEqual({
      kind: "salvage_unavailable_kept",
      reason: expect.stringContaining("container not running"),
    });
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("removes a clean, pushed worktree without committing or pushing", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    const { sandbox, calls, execs } = salvageSandbox({
      status: { stdout: "" },
      "rev-parse": [{ stdout: `${SHA}\n` }, { stdout: `${SHA}\n` }],
    });

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: IDENTITY,
      sandbox,
      image: IMAGE,
      resourceLimits: LIMITS,
      askpassBaseDir,
    });

    expect(result).toEqual({ kind: "removed_clean" });
    expect(calls.filter((c) => c.startsWith("exec:"))).toEqual([
      "exec:status",
      "exec:rev-parse",
      "exec:rev-parse",
    ]);
    expect(execs[2]?.cmd).toContain(`refs/remotes/origin/${branch}`);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("WIP-pushes a clean worktree whose branch was never pushed", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    const { sandbox, calls } = salvageSandbox({
      status: { stdout: "" },
      // HEAD resolves; `refs/remotes/origin/<branch>` does not.
      "rev-parse": [{ stdout: `${SHA}\n` }, { exitCode: 1 }, { stdout: `${SHA}\n` }],
      push: {},
    });

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: IDENTITY,
      sandbox,
      image: IMAGE,
      resourceLimits: LIMITS,
      askpassBaseDir,
    });

    expect(result.kind).toBe("wip_pushed_and_removed");
    expect(calls).not.toContain("exec:commit");
    expect(calls).toContain("exec:push");
  });

  it("keeps a dirty worktree, with no askpass mounted, when no identity is supplied", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox, specs, calls } = salvageSandbox(DIRTY_SCRIPT);

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      sandbox,
      image: IMAGE,
      resourceLimits: LIMITS,
      askpassBaseDir,
    });

    expect(result).toEqual({
      kind: "wip_push_failed_kept",
      reason: expect.stringMatching(/no GitHub identity/),
    });
    expect(specs[0]?.askpass).toBeUndefined();
    expect(calls).not.toContain("exec:commit");
    expect(existsSync(join(worktreePath, "in-progress.ts"))).toBe(true);
  });

  it("keeps the worktree when the WIP push fails", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox } = salvageSandbox({
      ...DIRTY_SCRIPT,
      push: { exitCode: 128, stderr: "fatal: unable to access remote\n" },
    });

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: IDENTITY,
      sandbox,
      image: IMAGE,
      resourceLimits: LIMITS,
      askpassBaseDir,
    });

    expect(result).toEqual({
      kind: "wip_push_failed_kept",
      reason: expect.stringContaining("unable to access remote"),
    });
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("returns no_worktree without a container when the path is gone", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    rmSync(worktreePath, { recursive: true, force: true });
    const { sandbox, calls } = salvageSandbox({});

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: IDENTITY,
      sandbox,
      image: IMAGE,
      resourceLimits: LIMITS,
      askpassBaseDir,
    });

    expect(result).toEqual({ kind: "no_worktree" });
    expect(calls).toEqual([]);
    // The path is free for a later allocation.
    await expect(
      allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: join(baseDir, "remote") }),
    ).resolves.toBeDefined();
  });

  it("keeps the worktree, and creates nothing, when the task's containers cannot be reaped", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    const { sandbox, calls } = salvageSandbox(DIRTY_SCRIPT);
    vi.mocked(sandbox.deleteByTaskId).mockRejectedValueOnce(new Error("daemon restarting"));

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: IDENTITY,
      sandbox,
      image: IMAGE,
      resourceLimits: LIMITS,
      askpassBaseDir,
    });

    expect(result).toEqual({
      kind: "salvage_unavailable_kept",
      reason: expect.stringContaining("daemon restarting"),
    });
    expect(calls).not.toContain("create");
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("settles on the salvage's outcome when deleting the salvage container fails", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox } = salvageSandbox(DIRTY_SCRIPT);
    vi.mocked(sandbox.deleteByTaskId)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("daemon restarting"));

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: IDENTITY,
      sandbox,
      image: IMAGE,
      resourceLimits: LIMITS,
      askpassBaseDir,
    });

    // The container is the reaper's; the askpass dir goes regardless.
    expect(result.kind).toBe("wip_pushed_and_removed");
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(askpassBaseDir, taskId))).toBe(false);
  });
});

describe("safeTeardownWorktree", () => {
  const FAKE_TX = { __mockTx: true } as never;

  function deps(secretsStore: SecretsStore, sandbox: ReturnType<typeof salvageSandbox>["sandbox"]) {
    return {
      runInTx: <T>(cb: (tx: never) => Promise<T>) => cb(FAKE_TX),
      secretsStore,
      sandbox,
      devbaseImage: IMAGE,
      defaultResourceLimits: LIMITS,
      askpassBaseDir,
    };
  }

  it("mounts the repo identity's askpass in the task image", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockResolvedValue(serializeGitHubIdentity(IDENTITY));
    const { sandbox, specs } = salvageSandbox(DIRTY_SCRIPT);

    await safeTeardownWorktree(deps(secretsStore, sandbox), {
      repo: codingRepoRow({ localPath: repoPath }),
      taskId,
      worktreeAssignment: { type: "host-path", branch, worktreePath },
    });

    expect(specs[0]).toMatchObject({
      image: IMAGE,
      askpass: { hostDir: join(askpassBaseDir, taskId) },
    });
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("salvages without askpass, keeping a dirty tree, when the identity cannot be resolved", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockResolvedValue(undefined);
    const { sandbox, specs } = salvageSandbox(DIRTY_SCRIPT);

    await safeTeardownWorktree(deps(secretsStore, sandbox), {
      repo: codingRepoRow({ localPath: repoPath }),
      taskId,
      worktreeAssignment: { type: "host-path", branch, worktreePath },
    });

    expect(specs).toHaveLength(1);
    expect(specs[0]?.askpass).toBeUndefined();
    expect(existsSync(join(worktreePath, "in-progress.ts"))).toBe(true);
  });

  it("resolves even when the identity lookup throws", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockRejectedValue(new Error("connection terminated"));
    const { sandbox, calls } = salvageSandbox(DIRTY_SCRIPT);

    await expect(
      safeTeardownWorktree(deps(secretsStore, sandbox), {
        repo: codingRepoRow({ localPath: repoPath }),
        taskId,
        worktreeAssignment: { type: "host-path", branch, worktreePath },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("touches no sandbox for a git-remote assignment", async () => {
    const { sandbox, calls } = salvageSandbox({});

    await safeTeardownWorktree(deps(mock<SecretsStore>(), sandbox), {
      repo: codingRepoRow({ localPath: repoPath }),
      taskId: uniqueTaskId(),
      worktreeAssignment: { type: "git-remote", branch: "cogmo/abc" },
    });

    expect(calls).toEqual([]);
  });
});
