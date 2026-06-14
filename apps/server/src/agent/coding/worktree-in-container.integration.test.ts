/// <reference path="../../../test/vitest.d.ts" />

/**
 * Regression contract: the working tree that `allocateWorktree`
 * materializes on the host must be git-operable from INSIDE a task
 * container, where it's bind-mounted at `/workspace` and nothing else
 * from the host filesystem exists. A linked `git worktree` violates
 * this — its `.git` file points at an absolute gitdir inside the parent
 * repo, so every in-container git command (starting with the
 * `git status --porcelain` that `runCommitAndPush` issues first) dies
 * with "fatal: not a git repository". Unit tests can't see that: host-side
 * git resolves the same absolute path fine. This test closes the gap by
 * running the real allocation against a real container.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transactor } from "../../db/index.js";
import { LocalDockerSandboxClient, type SandboxSession } from "../../sandbox/index.js";
import { DrizzleSandboxStore } from "../../sandbox/store/index.js";
import { LABEL_INSTANCE, LABEL_MANAGED } from "../../sandbox/supervisor.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import { createTestDatabase } from "../../test/pglite.js";
import { allocateWorktree } from "./worktree.js";

const execFileP = promisify(execFile);

// Pinned tiny image with git + sh. The supervisor overrides the
// entrypoint with `/bin/sleep infinity`, so the image's own git
// entrypoint never runs.
const GIT_IMAGE =
  "mirror.gcr.io/alpine/git:v2.49.1@sha256:c0280cf9572316299b08544065d3bf35db65043d5e3963982ec50647d2746e26";

// Same rationale as supervisor.integration.test.ts: runc so dev machines
// don't need sysbox; the sysbox-specific path runs on GHA.
const RUNTIME = "runc";

const RESOURCE_LIMITS: ResourceLimits = {
  cpus: 0.5,
  memory_bytes: 256 * 1024 * 1024,
  pids: 64,
};

// The container execs as the image's default user (root here) while the
// bind-mounted tree is owned by the host test uid, which trips git's
// CVE-2022-24765 ownership check before anything else runs. Production
// alignment of uids is the deployment's job (sysbox id-maps bind mounts);
// this test pins the gitdir-resolution contract, not ownership, so it
// declares /workspace safe via config env.
const GIT_ENV = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "/workspace",
};

let tx: Transactor;
let closeDb: () => Promise<void>;
let store: DrizzleSandboxStore;
let docker: Docker;
let baseDir: string;
let repoPath: string;
let sandbox: LocalDockerSandboxClient;
let instanceId: string;

beforeAll(async () => {
  docker = new Docker();
  try {
    await docker.ping();
  } catch (err) {
    throw new Error(
      `Docker daemon unreachable — worktree-in-container integration test requires Docker. ${(err as Error).message}`,
    );
  }
  const stream = await docker.pull(GIT_IMAGE);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });

  ({ tx, close: closeDb } = await createTestDatabase());
  store = new DrizzleSandboxStore();
  const inst = await tx((trx) =>
    store.insertInstance(trx, { host: "test-host", pid: process.pid }),
  );
  instanceId = inst.id;
  sandbox = await LocalDockerSandboxClient.create({
    docker,
    store,
    runInTx: tx,
    runtime: RUNTIME,
    instanceId: inst.id,
  });

  baseDir = mkdtempSync(join(tmpdir(), "cogmo-wt-container-it-"));
  repoPath = join(baseDir, "repo");
  await execFileP("git", ["init", "--initial-branch=main", repoPath]);
  await execFileP("git", ["-C", repoPath, "config", "user.email", "t@t"]);
  await execFileP("git", ["-C", repoPath, "config", "user.name", "t"]);
  await execFileP("git", ["-C", repoPath, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  await execFileP("git", ["-C", repoPath, "add", "."]);
  await execFileP("git", ["-C", repoPath, "commit", "-m", "init"]);
}, 120_000);

afterAll(async () => {
  const leftover = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL_MANAGED}=true`, `${LABEL_INSTANCE}=${instanceId}`] },
  });
  for (const c of leftover) {
    await docker
      .getContainer(c.Id)
      .remove({ force: true })
      .catch(() => {});
  }
  await sandbox.shutdown();
  rmSync(baseDir, { recursive: true, force: true });
  await closeDb();
});

async function gitInContainer(
  session: SandboxSession,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await session.exec(["git", ...args], {
    workingDir: "/workspace",
    env: GIT_ENV,
    timeoutMs: 60_000,
    idleTimeoutMs: 30_000,
  });
  return result;
}

describe("allocateWorktree output inside a task container (real Docker, runc)", () => {
  it("supports status, commit, and rev-parse from /workspace; commits are visible on the host", async () => {
    const taskId = "019d0000-0000-7000-8000-0000000a0001";
    const branch = "cogmo/itest0001";
    const worktreePath = join(baseDir, "worktrees", "repo", "itest0001");
    await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: "https://github.com/user/fixture.git",
    });

    const session = await sandbox.create({
      taskId,
      worktree: { type: "host-path", hostPath: worktreePath },
      image: GIT_IMAGE,
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 120_000),
    });

    try {
      // The exact first command runCommitAndPush issues — the one that
      // failed with "fatal: not a git repository: <parent gitdir>" when
      // the tree was a linked worktree.
      const status = await gitInContainer(session, ["status", "--porcelain"]);
      expect(status.stderr).toBe("");
      expect(status.exitCode).toBe(0);

      const branchOut = await gitInContainer(session, ["rev-parse", "--abbrev-ref", "HEAD"]);
      expect(branchOut.exitCode).toBe(0);
      expect(branchOut.stdout.trim()).toBe(branch);

      // Commit from inside the container, mirroring runCommitAndPush's
      // add -A → commit sequence (unsigned — signing needs the askpass
      // key material, out of scope for the gitdir contract).
      const write = await session.exec(
        ["/bin/sh", "-c", "echo 'edited in container' > change.txt"],
        { workingDir: "/workspace", timeoutMs: 60_000, idleTimeoutMs: 30_000 },
      );
      expect(write.exitCode).toBe(0);
      const add = await gitInContainer(session, ["add", "-A"]);
      expect(add.exitCode).toBe(0);
      const commit = await gitInContainer(session, [
        "-c",
        "user.email=bot@test",
        "-c",
        "user.name=bot",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "in-container commit",
      ]);
      expect(commit.stderr).toBe("");
      expect(commit.exitCode).toBe(0);

      // The bind mount makes the in-container commit durable on the host:
      // teardown's dirty/unpushed detection reads the same tree.
      const { stdout: hostSubject } = await execFileP("git", [
        "-C",
        worktreePath,
        "log",
        "-1",
        "--format=%s",
      ]);
      expect(hostSubject.trim()).toBe("in-container commit");
    } finally {
      // The image's root user owns whatever it wrote into the bind mount
      // (objects, change.txt); hand ownership back to the host test uid
      // so afterAll's rmSync can clean the temp dir.
      await session
        .exec(
          ["/bin/sh", "-c", `chown -R ${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0} .`],
          { workingDir: "/workspace", timeoutMs: 60_000, idleTimeoutMs: 30_000 },
        )
        .catch(() => {});
      // Swallow teardown errors so a failure here can't replace an
      // assertion error from the try block (afterAll force-removes any
      // container this leaks).
      await sandbox.delete(session).catch(() => {});
    }
  }, 120_000);
});
