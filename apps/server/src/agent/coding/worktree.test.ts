import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { expectDefined } from "../../test/assertions.js";
import { allocateWorktree, readHeadSha, removeWorktree } from "./worktree.js";

// A pass-through spy on `rm`, so every other case in this file keeps deleting
// for real and only the retry contract below inspects the options. Node applies
// `maxRetries` inside `rm` itself, so a stub that failed once to prove the
// retry would be mocking away the mechanism under test — the call contract is
// the most this can honestly assert.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

/** Every host `execFile` the module under test runs. */
const hostSpawns = vi.hoisted((): Array<{ file: string; args: ReadonlyArray<string> }> => []);

// A pass-through recorder, so the adopt check can be held to reading HEAD as
// a file: the clone it inspects is the tree the sandbox writes.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify: promisifyFn } = await import("node:util");
  const execFileAsync = promisifyFn(actual.execFile);
  function execFile(...params: unknown[]): unknown {
    return Reflect.apply(actual.execFile, undefined, params);
  }
  Object.defineProperty(execFile, promisifyFn.custom, {
    value: (...params: unknown[]): unknown => {
      hostSpawns.push({
        file: String(params[0]),
        args: Array.isArray(params[1]) ? params[1].map(String) : [],
      });
      return Reflect.apply(execFileAsync, undefined, params);
    },
  });
  return { ...actual, execFile };
});

const execFileP = promisify(execFile);

const REMOTE_URL = "https://github.com/user/cogmo.git";

let baseDir: string;
let repoPath: string;
let bareRepoPath: string;

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-worktree-test-"));
  repoPath = join(baseDir, "repo");
  await execFileP("git", ["init", "--initial-branch=main", repoPath]);
  await execFileP("git", ["-C", repoPath, "config", "user.email", "t@t"]);
  await execFileP("git", ["-C", repoPath, "config", "user.name", "t"]);
  await execFileP("git", ["-C", repoPath, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoPath, "README.md"), "hello");
  await execFileP("git", ["-C", repoPath, "add", "."]);
  await execFileP("git", ["-C", repoPath, "commit", "-m", "init"]);

  // The skills repo registers a BARE repo as `local_path` — cloning from
  // bare must work too.
  bareRepoPath = join(baseDir, "bare-repo.git");
  await execFileP("git", ["clone", "--bare", repoPath, bareRepoPath]);
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function uniqueWorktreePath(): string {
  return join(baseDir, "worktrees", `wt-${Math.random().toString(36).slice(2, 10)}`);
}

function uniqueBranch(): string {
  return `cogmo/${Math.random().toString(36).slice(2, 10)}`;
}

async function headOf(path: string): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

async function shaOf(path: string, rev: string): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", path, "rev-parse", rev]);
  return stdout.trim();
}

/** Commit a change to `file.txt` on the checked-out branch; the new commit's sha. */
async function commitChange(path: string, label: string): Promise<string> {
  writeFileSync(join(path, "file.txt"), `${label}\n`);
  await execFileP("git", ["-C", path, "add", "."]);
  await execFileP("git", [
    "-C",
    path,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    label,
  ]);
  return shaOf(path, "HEAD");
}

/** A fresh repo whose `main` holds `count` commits, with their shas oldest first. */
async function repoWithCommits(count: number): Promise<{ path: string; shas: string[] }> {
  const path = join(baseDir, `parent-${Math.random().toString(36).slice(2, 10)}`);
  await execFileP("git", ["init", "--initial-branch=main", path]);
  const shas: string[] = [];
  for (let i = 0; i < count; i++) shas.push(await commitChange(path, `commit ${i}`));
  return { path, shas };
}

async function originUrlOf(path: string): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", path, "remote", "get-url", "origin"]);
  return stdout.trim();
}

/**
 * Recursively collect files under `dir` whose hard-link count exceeds 1.
 * Native walk rather than `find -links +1` so the assertion isn't tied to a
 * platform-specific `find`.
 */
function filesWithMultipleLinks(dir: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...filesWithMultipleLinks(full));
    } else if (entry.isFile() && statSync(full).nlink > 1) {
      hits.push(full);
    }
  }
  return hits;
}

describe("allocateWorktree", () => {
  it("materializes a standalone clone on the branch with origin set to the remote URL", async () => {
    const worktreePath = uniqueWorktreePath();
    const branch = uniqueBranch();
    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    expect(result.adopted).toBe(false);
    expect(await headOf(worktreePath)).toBe(branch);
    // Self-containment is the contract the task container depends on: a
    // linked worktree's `.git` is a file pointing at a host-absolute
    // gitdir, which doesn't resolve once the tree is bind-mounted at
    // /workspace. A standalone clone keeps `.git` as a directory inside
    // the tree.
    expect(statSync(join(worktreePath, ".git")).isDirectory()).toBe(true);
    expect(await originUrlOf(worktreePath)).toBe(REMOTE_URL);
    await removeWorktree(repoPath, worktreePath);
  });

  it("produces a tree whose git operations work after relocation (container-mount proxy)", async () => {
    // Renaming the tree simulates the container's view: same files,
    // different absolute path. git status/commit must keep working.
    const worktreePath = uniqueWorktreePath();
    const branch = uniqueBranch();
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });

    const movedPath = `${worktreePath}-moved`;
    renameSync(worktreePath, movedPath);
    writeFileSync(join(movedPath, "change.txt"), "edited in container\n");
    await execFileP("git", ["-C", movedPath, "add", "-A"]);
    await execFileP("git", [
      "-C",
      movedPath,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "in-container commit",
    ]);
    expect(await headOf(movedPath)).toBe(branch);
    rmSync(movedPath, { recursive: true, force: true });
  });

  it("clones from a bare parent repo (skills repo case)", async () => {
    const worktreePath = uniqueWorktreePath();
    const branch = uniqueBranch();
    const result = await allocateWorktree({
      repoPath: bareRepoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    expect(result.adopted).toBe(false);
    expect(await headOf(worktreePath)).toBe(branch);
    expect(statSync(join(worktreePath, ".git")).isDirectory()).toBe(true);
    await removeWorktree(bareRepoPath, worktreePath);
  });

  it("adopts an existing clone on the right branch (crash recovery)", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });

    // Re-allocate at the same path / branch — should adopt.
    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    expect(result.adopted).toBe(true);
    await removeWorktree(repoPath, worktreePath);
  });

  it("adopts by reading HEAD as a file, with no git process in the clone", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });

    hostSpawns.length = 0;
    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });

    expect(result.adopted).toBe(true);
    expect(hostSpawns.filter((c) => c.args.some((a) => a.startsWith(worktreePath)))).toEqual([]);
    await removeWorktree(repoPath, worktreePath);
  });

  it("refuses to adopt a clone whose HEAD is detached", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    const { stdout } = await execFileP("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
    writeFileSync(join(worktreePath, ".git", "HEAD"), stdout);

    await expect(
      allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: REMOTE_URL, baseSha: null }),
    ).rejects.toThrow(/<detached>/);
    await removeWorktree(repoPath, worktreePath);
  });

  it("refuses to adopt a clone whose HEAD is a symlink, without following it", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    // A host file that reads as the right HEAD: following the link would
    // adopt on content outside the clone.
    const decoy = join(baseDir, `decoy-head-${Math.random().toString(36).slice(2, 8)}`);
    writeFileSync(decoy, `ref: refs/heads/${branch}\n`);
    rmSync(join(worktreePath, ".git", "HEAD"));
    symlinkSync(decoy, join(worktreePath, ".git", "HEAD"));

    await expect(
      allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: REMOTE_URL, baseSha: null }),
    ).rejects.toThrow(/<detached>/);
    await removeWorktree(repoPath, worktreePath);
  });

  it("refuses to adopt a clone whose HEAD is over the 1 KiB cap, however it reads", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    // The right ref, padded with trailing whitespace the parse would accept,
    // to one byte over the cap.
    const ref = `ref: refs/heads/${branch}`;
    writeFileSync(join(worktreePath, ".git", "HEAD"), ref.padEnd(1025, "\n"));

    await expect(
      allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: REMOTE_URL, baseSha: null }),
    ).rejects.toThrow(/<detached>/);
    await removeWorktree(repoPath, worktreePath);
  });

  it("refuses to adopt a clone whose HEAD is a FIFO, without blocking on it", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    rmSync(join(worktreePath, ".git", "HEAD"));
    await execFileP("mkfifo", [join(worktreePath, ".git", "HEAD")]);

    await expect(
      allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: REMOTE_URL, baseSha: null }),
    ).rejects.toThrow(/<detached>/);
    await removeWorktree(repoPath, worktreePath);
  });

  it("replaces a clone whose .git is a symlink, leaving the link's target alone", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    // A real clone on the right branch elsewhere on the host: adopting through
    // the link would read, and later delete, state outside the tree.
    const decoy = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath: decoy,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    rmSync(join(worktreePath, ".git"), { recursive: true, force: true });
    symlinkSync(join(decoy, ".git"), join(worktreePath, ".git"));

    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });

    expect(result.adopted).toBe(false);
    expect(lstatSync(join(worktreePath, ".git")).isDirectory()).toBe(true);
    expect(await headOf(worktreePath)).toBe(branch);
    expect(statSync(join(decoy, ".git", "HEAD")).isFile()).toBe(true);
    await removeWorktree(repoPath, worktreePath);
    await removeWorktree(repoPath, decoy);
  });

  it("replaces a legacy linked worktree at the path with a standalone clone", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    mkdirSync(join(baseDir, "worktrees"), { recursive: true });
    await execFileP("git", ["-C", repoPath, "worktree", "add", "-b", branch, worktreePath]);
    // Linked worktree: `.git` is a file.
    expect(statSync(join(worktreePath, ".git")).isFile()).toBe(true);

    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    expect(result.adopted).toBe(false);
    expect(statSync(join(worktreePath, ".git")).isDirectory()).toBe(true);
    expect(await headOf(worktreePath)).toBe(branch);
    await removeWorktree(repoPath, worktreePath);
  });

  it("recovers when a stale staging dir is left from a crashed allocation", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    mkdirSync(`${worktreePath}.partial`, { recursive: true });
    writeFileSync(join(`${worktreePath}.partial`, "junk"), "crashed mid-clone");

    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    expect(result.adopted).toBe(false);
    expect(await headOf(worktreePath)).toBe(branch);
    expect(existsSync(`${worktreePath}.partial`)).toBe(false);
    await removeWorktree(repoPath, worktreePath);
  });

  it("throws when an existing clone is on the wrong branch", async () => {
    const branchA = uniqueBranch();
    const branchB = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      branch: branchA,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    await expect(
      allocateWorktree({
        repoPath,
        branch: branchB,
        worktreePath,
        remoteUrl: REMOTE_URL,
        baseSha: null,
      }),
    ).rejects.toThrow(/expected/);
    await removeWorktree(repoPath, worktreePath);
  });

  it("throws when the path exists but is not a git working tree", async () => {
    const worktreePath = uniqueWorktreePath();
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "junk"), "not a working tree");
    const branch = uniqueBranch();
    await expect(
      allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: REMOTE_URL, baseSha: null }),
    ).rejects.toThrow(/not a git working tree/);
  });

  it("creates the parent directory if it does not exist", async () => {
    const branch = uniqueBranch();
    const worktreePath = join(baseDir, "deep", "nested", "wt", branch.replace(/\//g, "-"));
    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    expect(result.adopted).toBe(false);
    await removeWorktree(repoPath, worktreePath);
  });

  it("does not hardlink objects into the parent repo (inode isolation)", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    // Every object file in the clone must have link count 1 — a hardlinked
    // object would share an inode with the parent repo, letting an
    // in-container write corrupt host state.
    expect(filesWithMultipleLinks(join(worktreePath, ".git", "objects"))).toEqual([]);
    await removeWorktree(repoPath, worktreePath);
  });
});

describe("allocateWorktree at a base commit", () => {
  it("cuts the branch at baseSha, not at the parent's main that moved since", async () => {
    const parent = await repoWithCommits(2);
    const [base, moved] = parent.shas;
    const worktreePath = uniqueWorktreePath();
    const branch = uniqueBranch();

    await allocateWorktree({
      repoPath: parent.path,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: expectDefined(base, "base sha"),
    });

    expect(await headOf(worktreePath)).toBe(branch);
    expect(await shaOf(worktreePath, "HEAD")).toBe(base);
    expect(await shaOf(parent.path, "main")).toBe(moved);
    await removeWorktree(parent.path, worktreePath);
  });

  it("cuts the branch at baseSha after the parent's HEAD, on another branch, moved", async () => {
    const parent = await repoWithCommits(1);
    await execFileP("git", ["-C", parent.path, "checkout", "-b", "feature"]);
    const base = await commitChange(parent.path, "base");
    const moved = await commitChange(parent.path, "moved");
    const worktreePath = uniqueWorktreePath();
    const branch = uniqueBranch();

    await allocateWorktree({
      repoPath: parent.path,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: base,
    });

    expect(await shaOf(worktreePath, "HEAD")).toBe(base);
    expect(await shaOf(parent.path, "HEAD")).toBe(moved);
    await removeWorktree(parent.path, worktreePath);
  });

  it("cuts the branch at the parent's HEAD when no base was recorded", async () => {
    const parent = await repoWithCommits(2);
    const worktreePath = uniqueWorktreePath();
    const branch = uniqueBranch();

    await allocateWorktree({
      repoPath: parent.path,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });

    expect(await shaOf(worktreePath, "HEAD")).toBe(parent.shas[1]);
    await removeWorktree(parent.path, worktreePath);
  });
});

describe("readHeadSha", () => {
  it("returns the commit HEAD names, on a branch other than main", async () => {
    const parent = await repoWithCommits(1);
    await execFileP("git", ["-C", parent.path, "checkout", "-b", "feature"]);
    const featureTip = await commitChange(parent.path, "on feature");

    expect(await readHeadSha(parent.path)).toBe(featureTip);
    expect(featureTip).not.toBe(parent.shas[0]);
  });

  it("returns the commit main names in a bare repo, whose HEAD is main", async () => {
    const parent = await repoWithCommits(1);
    const bare = `${parent.path}.git`;
    await execFileP("git", ["clone", "--bare", parent.path, bare]);

    expect(await readHeadSha(bare)).toBe(parent.shas[0]);
  });

  it("returns null when HEAD names no commit, in an empty repo bare or not", async () => {
    const empty = join(baseDir, `empty-${Math.random().toString(36).slice(2, 10)}`);
    await execFileP("git", ["init", "--initial-branch=main", empty]);
    await execFileP("git", ["init", "--bare", "--initial-branch=main", `${empty}.git`]);

    expect(await readHeadSha(empty)).toBeNull();
    expect(await readHeadSha(`${empty}.git`)).toBeNull();
  });

  it("rejects any other git failure", async () => {
    await expect(readHeadSha(join(baseDir, "no-such-repo"))).rejects.toThrow(/no-such-repo/);
  });
});

describe("removeWorktree", () => {
  it("removes an existing clone", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });
    await removeWorktree(repoPath, worktreePath);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("is a no-op when the path does not exist", async () => {
    await expect(removeWorktree(repoPath, "/no/such/path")).resolves.toBeUndefined();
  });

  it("prunes legacy linked-worktree metadata so the path can be re-allocated", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    mkdirSync(join(baseDir, "worktrees"), { recursive: true });
    await execFileP("git", ["-C", repoPath, "worktree", "add", "-b", branch, worktreePath]);

    await removeWorktree(repoPath, worktreePath);
    expect(existsSync(worktreePath)).toBe(false);
    // Without the prune, the parent repo's stale `worktrees/<name>`
    // registration would block `git worktree add` at the same path; the
    // clone path doesn't care, but the metadata shouldn't accumulate.
    const { stdout } = await execFileP("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
    expect(stdout).not.toContain(worktreePath);
  });

  it("retries the delete so a process still writing in the tree can't leave it half-removed", async () => {
    // `force` only swallows ENOENT. A writer inside the tree — git's own
    // background maintenance, or a sandbox process on a bind mount — makes the
    // walk fail with ENOTEMPTY partway through, and `removeWorktree` logs that
    // rather than raising it, so the half-deleted tree is only noticed when the
    // next allocation at the path refuses it.
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({
      repoPath,
      worktreePath,
      branch,
      remoteUrl: REMOTE_URL,
      baseSha: null,
    });

    const rmSpy = vi.mocked(rm);
    rmSpy.mockClear();
    await removeWorktree(repoPath, worktreePath);

    expect(rmSpy).toHaveBeenCalled();
    for (const call of rmSpy.mock.calls) {
      expect(call[1]).toMatchObject({ recursive: true, force: true, maxRetries: 3 });
    }
  });
});
