import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  (): Array<{ file: string; args: ReadonlyArray<string>; cwd: string | undefined }> => [],
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
const REMOTE_URL = "https://github.com/user/cogmo.git";

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
  /** Which `create` handed out the session: 0 for the first salvage container. */
  container: number;
  cmd: ReadonlyArray<string>;
  workingDir: string | undefined;
  env: Readonly<Record<string, string>> | undefined;
}

/** The git sub-command of an exec argv, past the leading `-c key=value` pairs and `--git-dir`. */
function subcommandOf(cmd: ReadonlyArray<string>): string | undefined {
  for (let i = 1; i < cmd.length; i++) {
    const arg = cmd[i];
    if (arg === "-c") {
      i++;
      continue;
    }
    if (arg?.startsWith("--git-dir=")) continue;
    return arg;
  }
  return undefined;
}

type ScriptEntry = FakeExecScript | ((cmd: ReadonlyArray<string>) => FakeExecScript);

/**
 * The sandbox teardown salvages in. Each `create` hands out a session whose
 * execs answer from `script` by git sub-command; `calls` records the client
 * calls in order, and `askpassFiles` what each create found in the askpass
 * dir it was asked to mount.
 */
function salvageSandbox(script: Record<string, ScriptEntry>, opts: { createFails?: Error } = {}) {
  const calls: string[] = [];
  const specs: SessionSpec[] = [];
  const askpassFiles: Array<ReadonlyArray<string> | undefined> = [];
  const execs: RecordedExec[] = [];
  const sessionFor = (container: number): SandboxSession => ({
    state: { type: "local-docker", taskId: "t", containerRowId: "row", dockerId: "docker" },
    execStreaming: vi.fn(
      async (cmd: ReadonlyArray<string>, o?: ExecOptions): Promise<ExecStreamingHandle> => {
        const sub = subcommandOf(cmd);
        calls.push(`exec:${sub ?? "?"}`);
        execs.push({ container, cmd, workingDir: o?.workingDir, env: o?.env });
        const entry = sub === undefined ? undefined : script[sub];
        if (entry === undefined) throw new Error(`no scripted result for: ${cmd.join(" ")}`);
        return fakeExecHandle(typeof entry === "function" ? entry(cmd) : entry);
      },
    ),
    exec: vi.fn(),
  });
  const sandbox: Pick<SandboxClient, "ensureImagePresent" | "create" | "deleteByTaskId"> = {
    ensureImagePresent: vi.fn(async () => {
      calls.push("ensureImagePresent");
    }),
    create: vi.fn(async (spec: SessionSpec) => {
      calls.push(spec.askpass ? "create:askpass" : "create");
      specs.push(spec);
      askpassFiles.push(spec.askpass ? readdirSync(spec.askpass.hostDir).sort() : undefined);
      if (opts.createFails) throw opts.createFails;
      return sessionFor(specs.length - 1);
    }),
    deleteByTaskId: vi.fn(async () => {
      calls.push("deleteByTaskId");
    }),
  };
  return { sandbox, calls, specs, askpassFiles, execs };
}

/** A tree with uncommitted work: after the WIP commit, HEAD holds one commit no remote ref has. */
const DIRTY_SCRIPT: Record<string, ScriptEntry> = {
  status: { stdout: "?? in-progress.ts\n" },
  add: {},
  commit: { stdout: "[cogmo/x 1234567] wip\n" },
  "rev-parse": { stdout: `${SHA}\n` },
  "rev-list": { stdout: "1\n" },
  init: {},
  fetch: {},
  push: { stderr: "To github.com\n" },
};

const SALVAGE_FLAGS = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "credential.helper="];

function teardown(
  sandbox: ReturnType<typeof salvageSandbox>["sandbox"],
  args: { taskId: string; worktreePath: string; identity?: GitHubIdentity },
) {
  return teardownWorktree({
    repoPath,
    remoteUrl: REMOTE_URL,
    ...args,
    sandbox,
    image: IMAGE,
    resourceLimits: LIMITS,
    askpassBaseDir,
    scratchGitDir: "/tmp/cogmo-wip.git",
  });
}

describe("teardownWorktree", () => {
  it("runs no host git inside the worktree", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox } = salvageSandbox(DIRTY_SCRIPT);

    hostSpawns.length = 0;
    await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(hostGitInside(worktreePath)).toEqual([]);
  });

  it("commits with no credential mounted, then pushes from a second container holding only the PAT", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox, calls, specs, askpassFiles, execs } = salvageSandbox(DIRTY_SCRIPT);

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "wip_pushed_and_removed",
      wipRef: `refs/cogmo-wip/${taskId}`,
      sha: SHA,
    });
    // The task's own containers go first; each salvage container is reaped
    // before the next step.
    expect(calls).toEqual([
      "deleteByTaskId",
      "ensureImagePresent",
      "create",
      "exec:status",
      "exec:add",
      "exec:commit",
      "exec:rev-parse",
      "exec:rev-list",
      "deleteByTaskId",
      "create:askpass",
      "exec:init",
      "exec:fetch",
      "exec:rev-parse",
      "exec:push",
      "deleteByTaskId",
    ]);
    const [commitSpec, pushSpec] = specs;
    expect(commitSpec).toMatchObject({
      taskId,
      image: IMAGE,
      resourceLimits: LIMITS,
      worktree: { type: "host-path", hostPath: worktreePath },
    });
    expect(expectDefined(commitSpec, "commit spec").askpass).toBeUndefined();
    expect(expectDefined(pushSpec, "push spec")).toMatchObject({
      worktree: { type: "host-path", hostPath: worktreePath },
      askpass: { hostDir: join(askpassBaseDir, taskId), containerDir: CONTAINER_ASKPASS_DIR },
    });
    // No Claude token and no home volume in either.
    for (const spec of specs) {
      expect(spec.env).toBeUndefined();
      expect(spec.homeVolume).toBeUndefined();
    }
    // The WIP commit is unsigned: the signing key is not mounted.
    expect(askpassFiles[1]).toEqual(["helper", "pat"]);

    for (const e of execs) {
      expect(e.cmd).toEqual(expect.arrayContaining(SALVAGE_FLAGS));
    }
    const push = expectDefined(
      execs.find((e) => subcommandOf(e.cmd) === "push"),
      "push exec",
    );
    expect(push.container).toBe(1);
    expect(push.env).toMatchObject({
      GIT_ASKPASS: `${CONTAINER_ASKPASS_DIR}/helper`,
      GIT_TERMINAL_PROMPT: "0",
    });
    // By URL, from the scratch repo: the tree's `origin` is never read.
    expect(push.cmd).toEqual(
      expect.arrayContaining([
        "--git-dir=/tmp/cogmo-wip.git",
        "--force",
        REMOTE_URL,
        `refs/cogmo-wip/${taskId}:refs/cogmo-wip/${taskId}`,
      ]),
    );
    expect(push.cmd).not.toContain("origin");
    for (const e of execs.filter((x) => x !== push)) {
      expect(e.env?.GIT_ASKPASS).toBeUndefined();
    }
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(askpassBaseDir, taskId))).toBe(false);
  });

  it("removes a clean worktree whose commits a remote ref holds, without the credential container", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    const { sandbox, calls, execs } = salvageSandbox({
      status: { stdout: "" },
      "rev-parse": { stdout: `${SHA}\n` },
      "rev-list": { stdout: "0\n" },
    });

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({ kind: "removed_clean" });
    expect(calls).not.toContain("create:askpass");
    expect(calls).not.toContain("exec:commit");
    expect(execs[2]?.cmd).toEqual(
      expect.arrayContaining(["rev-list", "--count", "HEAD", "--not", "--remotes"]),
    );
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("pushes a clean worktree with commits no remote ref holds, without a commit", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    const { sandbox, calls } = salvageSandbox({ ...DIRTY_SCRIPT, status: { stdout: "" } });

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result.kind).toBe("wip_pushed_and_removed");
    expect(calls).not.toContain("exec:commit");
    expect(calls).toContain("exec:push");
  });

  it("keeps the worktree, and creates no credential container, when no identity is supplied", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox, specs } = salvageSandbox(DIRTY_SCRIPT);

    const result = await teardown(sandbox, { taskId, worktreePath });

    expect(result).toEqual({
      kind: "wip_push_failed_kept",
      reason: expect.stringMatching(/no GitHub identity/),
    });
    expect(specs).toHaveLength(1);
    expect(expectDefined(specs[0], "commit spec").askpass).toBeUndefined();
    expect(existsSync(join(worktreePath, "in-progress.ts"))).toBe(true);
  });

  it("keeps the worktree and runs no host git when no container can be created", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox, calls } = salvageSandbox(DIRTY_SCRIPT, {
      createFails: new Error("connect ENOENT /var/run/docker.sock"),
    });

    hostSpawns.length = 0;
    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "salvage_unavailable_kept",
      reason: expect.stringContaining("docker.sock"),
    });
    expect(hostGitInside(worktreePath)).toEqual([]);
    expect(existsSync(join(worktreePath, "in-progress.ts"))).toBe(true);
    expect(calls.at(-1)).toBe("deleteByTaskId");
  });

  it("keeps the worktree when the container dies mid-commit", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox, calls } = salvageSandbox({
      ...DIRTY_SCRIPT,
      add: { transportError: new Error("container not running") },
    });

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "salvage_unavailable_kept",
      reason: expect.stringContaining("container not running"),
    });
    expect(calls).not.toContain("create:askpass");
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("keeps the worktree when the WIP push fails", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox } = salvageSandbox({
      ...DIRTY_SCRIPT,
      push: { exitCode: 128, stderr: "fatal: unable to access remote\n" },
    });

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "wip_push_failed_kept",
      reason: expect.stringContaining("unable to access remote"),
    });
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(askpassBaseDir, taskId))).toBe(false);
  });

  it("refuses to push when the tree's HEAD moved after the commit", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const other = "0123456789012345678901234567890123456789";
    const { sandbox, calls } = salvageSandbox({
      ...DIRTY_SCRIPT,
      // The scratch repo's fetched ref is another commit than the tree's HEAD.
      "rev-parse": (cmd) => ({
        stdout: `${cmd.some((a) => a.startsWith("--git-dir=")) ? other : SHA}\n`,
      }),
    });

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "wip_push_failed_kept",
      reason: expect.stringContaining("HEAD moved"),
    });
    expect(calls).not.toContain("exec:push");
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("returns no_worktree without a container when the path is gone", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    rmSync(worktreePath, { recursive: true, force: true });
    const { sandbox, calls } = salvageSandbox({});

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({ kind: "no_worktree" });
    expect(calls).toEqual([]);
    // The path is free for a later allocation.
    await expect(
      allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: join(baseDir, "remote") }),
    ).resolves.toBeDefined();
  });

  it("keeps the worktree, and creates nothing, when the task's containers cannot be reaped", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    const { sandbox, calls } = salvageSandbox(DIRTY_SCRIPT);
    vi.mocked(sandbox.deleteByTaskId).mockRejectedValueOnce(new Error("daemon restarting"));

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "salvage_unavailable_kept",
      reason: expect.stringContaining("daemon restarting"),
    });
    expect(calls.filter((c) => c.startsWith("create"))).toEqual([]);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("keeps the worktree, and pushes nothing, when the commit container cannot be reaped", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox, calls } = salvageSandbox(DIRTY_SCRIPT);
    vi.mocked(sandbox.deleteByTaskId)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("daemon restarting"));

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    // The container may still have the tree mounted, and a process in it
    // still writing: no credential container joins it, and no delete races it.
    expect(result).toEqual({
      kind: "salvage_reap_failed_kept",
      reason: expect.stringContaining("daemon restarting"),
    });
    expect(calls).not.toContain("create:askpass");
    expect(existsSync(join(worktreePath, "in-progress.ts"))).toBe(true);
  });

  it("keeps the worktree when the push container cannot be reaped", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const { sandbox } = salvageSandbox(DIRTY_SCRIPT);
    vi.mocked(sandbox.deleteByTaskId)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("daemon restarting"));

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "salvage_reap_failed_kept",
      reason: expect.stringContaining("daemon restarting"),
    });
    expect(existsSync(join(worktreePath, "in-progress.ts"))).toBe(true);
    // The askpass dir goes regardless.
    expect(existsSync(join(askpassBaseDir, taskId))).toBe(false);
  });

  it("keeps the worktree, with no credential container, when a commit-stage command fails", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    const { sandbox, calls } = salvageSandbox({
      ...DIRTY_SCRIPT,
      add: { exitCode: 128, stderr: "fatal: Unable to create '.git/index.lock': File exists.\n" },
    });

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "wip_push_failed_kept",
      reason: expect.stringContaining("git add failed: fatal: Unable to create"),
    });
    expect(calls).not.toContain("create:askpass");
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("keeps the worktree, and creates nothing, when the image check rejects", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    const { sandbox, calls } = salvageSandbox(DIRTY_SCRIPT);
    vi.mocked(sandbox.ensureImagePresent).mockRejectedValueOnce(new Error("image not found"));

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "salvage_unavailable_kept",
      reason: expect.stringContaining("image not found"),
    });
    expect(calls.filter((c) => c.startsWith("create"))).toEqual([]);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("keeps the worktree, with no credential container, when the askpass dir cannot be written", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    // A file where the askpass root should be: the provisioning mkdir fails.
    askpassBaseDir = join(baseDir, "askpass-is-a-file");
    writeFileSync(askpassBaseDir, "");
    const { sandbox, calls } = salvageSandbox(DIRTY_SCRIPT);

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "salvage_unavailable_kept",
      reason: expect.stringContaining("askpass-is-a-file"),
    });
    expect(calls).not.toContain("create:askpass");
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("keeps the worktree when the push container dies mid-push", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    const { sandbox, calls } = salvageSandbox({
      ...DIRTY_SCRIPT,
      push: { transportError: new Error("container not running") },
    });

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "salvage_unavailable_kept",
      reason: expect.stringContaining("container not running"),
    });
    expect(calls.at(-1)).toBe("deleteByTaskId");
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(askpassBaseDir, taskId))).toBe(false);
  });

  it("reads an exec throw as unavailable even when the reap after it fails too", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath } = await allocatedWorktree(taskId);
    const { sandbox } = salvageSandbox({
      ...DIRTY_SCRIPT,
      add: { transportError: new Error("container not running") },
    });
    vi.mocked(sandbox.deleteByTaskId)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("daemon restarting"));

    const result = await teardown(sandbox, { taskId, worktreePath, identity: IDENTITY });

    expect(result).toEqual({
      kind: "salvage_unavailable_kept",
      reason: expect.stringContaining("container not running"),
    });
    expect(existsSync(worktreePath)).toBe(true);
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

  it("pushes to the repo's remote URL with its identity, in the task image", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockResolvedValue(serializeGitHubIdentity(IDENTITY));
    const { sandbox, specs, execs } = salvageSandbox(DIRTY_SCRIPT);

    const result = await safeTeardownWorktree(deps(secretsStore, sandbox), {
      repo: codingRepoRow({ localPath: repoPath, remoteUrl: REMOTE_URL }),
      taskId,
      worktreeAssignment: { type: "host-path", branch, worktreePath },
    });

    // The outcome is the step's result.
    expect(result).toEqual({
      kind: "wip_pushed_and_removed",
      wipRef: `refs/cogmo-wip/${taskId}`,
      sha: SHA,
    });
    expect(specs.map((s) => s.image)).toEqual([IMAGE, IMAGE]);
    expect(expectDefined(specs[1], "push spec").askpass?.hostDir).toBe(
      join(askpassBaseDir, taskId),
    );
    const push = expectDefined(
      execs.find((e) => subcommandOf(e.cmd) === "push"),
      "push exec",
    );
    expect(push.cmd).toContain(REMOTE_URL);
    // Unset in production: the scratch repo is the container path.
    expect(push.cmd).toContain("--git-dir=/tmp/cogmo-wip.git");
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("puts the scratch repo where the deps say", async () => {
    const taskId = uniqueTaskId();
    const { worktreePath, branch } = await allocatedWorktree(taskId);
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockResolvedValue(serializeGitHubIdentity(IDENTITY));
    const { sandbox, execs } = salvageSandbox({ ...DIRTY_SCRIPT, status: { stdout: "" } });

    await safeTeardownWorktree(
      { ...deps(secretsStore, sandbox), salvageScratchGitDir: "/scratch/wip.git" },
      {
        repo: codingRepoRow({ localPath: repoPath }),
        taskId,
        worktreeAssignment: { type: "host-path", branch, worktreePath },
      },
    );

    expect(execs.find((e) => subcommandOf(e.cmd) === "push")?.cmd).toContain(
      "--git-dir=/scratch/wip.git",
    );
  });

  it("creates no credential container, keeping a dirty tree, when the identity cannot be resolved", async () => {
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
    expect(expectDefined(specs[0], "commit spec").askpass).toBeUndefined();
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
    ).resolves.toEqual({
      kind: "errored",
      reason: expect.stringContaining("connection terminated"),
    });
    expect(calls).toEqual([]);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("touches no sandbox for a git-remote assignment", async () => {
    const { sandbox, calls } = salvageSandbox({});

    const result = await safeTeardownWorktree(deps(mock<SecretsStore>(), sandbox), {
      repo: codingRepoRow({ localPath: repoPath }),
      taskId: uniqueTaskId(),
      worktreeAssignment: { type: "git-remote", branch: "cogmo/abc" },
    });

    expect(result).toEqual({ kind: "no_host_worktree" });
    expect(calls).toEqual([]);
  });
});
