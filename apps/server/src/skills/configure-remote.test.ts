import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Octokit } from "@octokit/rest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { CodingRepoRow, CodingStore, InsertRepoParams } from "../agent/coding/store/index.js";
import type { BootstrapLock } from "../db/bootstrap-lock.js";
import type { Transactor } from "../db/index.js";
import type { GitHubIdentity } from "../secrets/github.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase } from "../test/pglite.js";
import { makeEmptyBareRepo, makePopulatedBareRepo } from "../test/skills-bare-repo.js";
import { configureSkillsRemote } from "./configure-remote.js";
import { migrateSkillsLayout } from "./migrate-layout.js";
import { bootstrapSkillsRepo } from "./repo.js";
import { DrizzleSkillStore, type SkillStore } from "./store/index.js";
import { findSkillsImageDir, loadReleaseToolchain, type ReleaseToolchain } from "./toolchain.js";
import { commitToolchain } from "./toolchain-commit.js";

const execFileP = promisify(execFile);

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const FAKE_IDENTITY: GitHubIdentity = {
  pat: "ghp_test",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n",
  sshPublicKey: "ssh-ed25519 AAAA fake",
  login: "test-user",
  id: "1",
};

/** A bootstrap lock that only runs its body; tests that watch the lock pass their own. */
const passLock: BootstrapLock = (fn) => fn();

/** A bootstrap lock that runs its body and counts how often it was taken. */
function countingLock(): { lock: BootstrapLock; taken: () => number } {
  let taken = 0;
  return {
    lock: (fn) => {
      taken += 1;
      return fn();
    },
    taken: () => taken,
  };
}

let toolchain: ReleaseToolchain;

beforeAll(async () => {
  toolchain = await loadReleaseToolchain(findSkillsImageDir(import.meta.url), "9.9.9");
});

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "configure-remote-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makePopulatedRemote(subdir = "owner"): Promise<string> {
  return (await makePopulatedBareRepo(workDir, subdir)).url;
}

async function makeEmptyRemote(subdir = "owner", name = "empty.git"): Promise<string> {
  return (await makeEmptyBareRepo(workDir, subdir, name)).url;
}

/**
 * Seed the skills bare repo with a commit on `refs/heads/main` —
 * exercises the "local populated" half of the direction state machine.
 *
 * Done via `git update-ref` (not `git push`) because the production
 * `pre-receive` hook installed by `bootstrapSkillsRepo` rejects direct
 * pushes to main: production `register` uses `update-ref` for the same
 * reason. The temp working clone first pushes objects under a throwaway
 * ref the hook allows, then update-ref points main at the same SHA on
 * the bare repo's filesystem.
 */
async function seedSkillsBare(skillsPath: string, message = "local commit"): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "configure-remote-skillsseed-"));
  try {
    await execFileP("git", ["init", "-b", "main", work]);
    await execFileP("git", ["-C", work, "config", "user.email", "t@t"]);
    await execFileP("git", ["-C", work, "config", "user.name", "t"]);
    await execFileP("git", ["-C", work, "config", "commit.gpgsign", "false"]);
    await writeFile(join(work, "marker.txt"), message);
    await execFileP("git", ["-C", work, "add", "."]);
    await execFileP("git", ["-C", work, "commit", "-m", message]);
    const { stdout } = await execFileP("git", ["-C", work, "rev-parse", "HEAD"]);
    const sha = stdout.trim();
    // Upload objects under a throwaway non-main ref — the hook rejects
    // direct pushes to main but accepts new refs elsewhere.
    const stagingRef = `refs/heads/__test-seed-${process.pid}-${Math.random()
      .toString(36)
      .slice(2)}`;
    await execFileP("git", ["-C", work, "push", skillsPath, `HEAD:${stagingRef}`]);
    // Now point main at the same SHA via filesystem update-ref —
    // production `register` does the same thing for the same reason.
    await execFileP("git", ["-C", skillsPath, "update-ref", "refs/heads/main", sha]);
    // Clean up the staging ref. `git update-ref -d` on the bare repo
    // bypasses the hook (which only fires on update of main); deleting a
    // non-main ref via filesystem-level update-ref is unconstrained.
    await execFileP("git", ["-C", skillsPath, "update-ref", "-d", stagingRef]);
    return sha;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function readOrigin(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "remote", "get-url", "origin"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function readMainSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      "refs/heads/main",
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await execFileP("git", ["-C", repo, ...args])).stdout.trim();
}

/**
 * A remote whose `main` holds `files`, committed on top of the populated
 * remote's seed commit.
 */
async function makeRemoteWith(files: Record<string, string>): Promise<string> {
  const { path, url } = await makePopulatedBareRepo(workDir, "owner");
  const work = await mkdtemp(join(tmpdir(), "configure-remote-remote-"));
  try {
    await execFileP("git", ["clone", "-q", path, work]);
    await git(work, "config", "user.email", "t@t");
    await git(work, "config", "user.name", "t");
    await git(work, "config", "commit.gpgsign", "false");
    for (const [file, content] of Object.entries(files)) {
      await mkdir(dirname(join(work, file)), { recursive: true });
      await writeFile(join(work, file), content);
    }
    await git(work, "add", "-A");
    await git(work, "commit", "-q", "-m", "remote files");
    await git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return url;
}

function rowFromParams(params: InsertRepoParams): CodingRepoRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: params.name,
    localPath: params.localPath,
    defaultBranch: params.defaultBranch,
    remoteUrl: params.remoteUrl,
    devcontainer: params.devcontainer,
    allowedBackends: [...params.allowedBackends],
    verifyCommand: params.verifyCommand,
    verifyTimeoutSeconds: params.verifyTimeoutSeconds ?? 600,
    taskTokenBudget: params.taskTokenBudget,
    taskWallTimeSeconds: params.taskWallTimeSeconds,
    maxConcurrentTasks: params.maxConcurrentTasks,
    identityName: params.identityName ?? "default",
    createdAt: new Date(),
  };
}

function setupStoreWithNoRow(): CodingStore {
  const store = mock<CodingStore>();
  store.getRepoByName.mockResolvedValue(undefined);
  store.insertOrRecoverRepo.mockImplementation(async (_tx, params) => ({
    kind: "new",
    row: rowFromParams(params),
  }));
  return store;
}

describe("configureSkillsRemote", () => {
  it("skip is a logged no-op — no DB or git work", async () => {
    const codingStore = mock<CodingStore>();
    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore,
        skillsRepoPath: join(workDir, "skills"),
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "skip" },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.kind).toBe("skipped");
    expect(codingStore.getRepoByName).not.toHaveBeenCalled();
  });

  it("own rejects empty URL before touching the bare repo", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore: setupStoreWithNoRow(),
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "adopt", remoteUrl: "   " },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("url_invalid");
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own rejects unparseable URL", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore: setupStoreWithNoRow(),
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "adopt", remoteUrl: "not-a-git-url" },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("url_invalid");
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own + adopt refuses an empty remote", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makeEmptyRemote();

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore: setupStoreWithNoRow(),
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "adopt", remoteUrl },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("remote_empty");
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own + publish refuses when local is empty", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makeEmptyRemote();

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore: setupStoreWithNoRow(),
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "publish", remoteUrl },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("local_empty");
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own + adopt fetches into an empty local from a populated remote", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makePopulatedRemote();
    const codingStore = setupStoreWithNoRow();

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore,
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "adopt", remoteUrl },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.kind === "configured") {
      expect(result.value.remoteUrl).toBe(remoteUrl);
      expect(result.value.direction).toBe("adopt");
      expect(result.value.originAction).toBe("attached");
      expect(result.value.ensured.kind).toBe("created");
    }
    expect(await readOrigin(skillsPath)).toBe(remoteUrl);
    expect(await readMainSha(skillsPath)).not.toBeNull();
    expect(codingStore.insertOrRecoverRepo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "skills", remoteUrl }),
    );
  });

  it("own + adopt replaces the bare layout commit and moves the adopted main", {
    timeout: 30_000,
  }, async () => {
    const { tx, close } = await createTestDatabase();
    try {
      const skillStore = new DrizzleSkillStore();
      const skillsPath = join(workDir, "skills.git");
      await bootstrapSkillsRepo({ path: skillsPath });
      // The boot's layout commit on an unborn main.
      const bare = await migrateSkillsLayout({ runInTx: tx, store: skillStore }, skillsPath);
      const remoteUrl = await makePopulatedRemote();
      const remoteSha = await readMainSha(remoteUrl.replace("file://", ""));

      const result = await configureSkillsRemote(
        {
          runInTx: tx,
          codingStore: setupStoreWithNoRow(),
          skillStore,
          skillsRepoPath: skillsPath,
          bootstrapLock: passLock,
          toolchain,
        },
        { kind: "own", direction: "adopt", remoteUrl },
      );

      expect(result.isOk()).toBe(true);
      const layout = await tx((trx) => skillStore.getLayoutCommitSha(trx));
      expect(layout).not.toBe(bare);
      const main = await readMainSha(skillsPath);
      // The toolchain commit on top of the adopted main's layout commit.
      expect(
        await git(
          skillsPath,
          "log",
          "-1",
          "--format=%P %(trailers:key=Cogmo-Toolchain,valueonly)",
          expectDefined(main, "main"),
        ),
      ).toBe(`${layout} 9.9.9`);
      expect(await git(skillsPath, "rev-parse", `${layout}^`)).toBe(remoteSha);
      // The remote gets the commits a git-remote task branches from.
      expect(await readMainSha(remoteUrl.replace("file://", ""))).toBe(main);
    } finally {
      await close();
    }
  });

  it("own + adopt over the bare layout commit keeps a deploy that lands between its classification and its swap", {
    timeout: 30_000,
  }, async () => {
    const { tx, close } = await createTestDatabase();
    try {
      const skillStore = new DrizzleSkillStore();
      const skillsPath = join(workDir, "skills.git");
      await bootstrapSkillsRepo({ path: skillsPath });
      const bare = await migrateSkillsLayout({ runInTx: tx, store: skillStore }, skillsPath);
      // A deploy on top of the bare layout commit, landing as the adopt drops
      // the layout row, the one point between its classification and its
      // swap a test can reach.
      const tree = (
        await execFileP("git", ["-C", skillsPath, "rev-parse", `${bare}^{tree}`])
      ).stdout.trim();
      const deploy = (
        await execFileP(
          "git",
          ["-C", skillsPath, "commit-tree", tree, "-p", bare, "-m", "deploy"],
          {
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "t",
              GIT_AUTHOR_EMAIL: "t@t",
              GIT_COMMITTER_NAME: "t",
              GIT_COMMITTER_EMAIL: "t@t",
            },
          },
        )
      ).stdout.trim();
      const forget = skillStore.forgetLayoutCommit.bind(skillStore);
      vi.spyOn(skillStore, "forgetLayoutCommit").mockImplementationOnce(async (trx) => {
        await forget(trx);
        await git(skillsPath, "update-ref", "refs/heads/main", deploy);
      });
      const remoteUrl = await makePopulatedRemote();

      const result = await configureSkillsRemote(
        {
          runInTx: tx,
          codingStore: setupStoreWithNoRow(),
          skillStore,
          skillsRepoPath: skillsPath,
          bootstrapLock: passLock,
          toolchain,
        },
        { kind: "own", direction: "adopt", remoteUrl },
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.kind).toBe("remote_diverged");
      expect(await readMainSha(skillsPath)).toBe(deploy);
      // The bare layout commit, still on main's history, is recorded again.
      expect(await tx((trx) => skillStore.getLayoutCommitSha(trx))).toBe(bare);
      expect(
        (await execFileP("git", ["-C", skillsPath, "for-each-ref", "refs/cogmo/"])).stdout,
      ).toBe("");
    } finally {
      await close();
    }
  });

  it("own + adopt over the bare layout commit stays configured when its push is refused", {
    timeout: 30_000,
  }, async () => {
    const { tx, close } = await createTestDatabase();
    try {
      const skillStore = new DrizzleSkillStore();
      const skillsPath = join(workDir, "skills.git");
      await bootstrapSkillsRepo({ path: skillsPath });
      await migrateSkillsLayout({ runInTx: tx, store: skillStore }, skillsPath);
      const remoteUrl = await makePopulatedRemote();
      const remotePath = remoteUrl.replace("file://", "");
      const remoteSha = await readMainSha(remotePath);
      await writeFile(join(remotePath, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });

      const result = await configureSkillsRemote(
        {
          runInTx: tx,
          codingStore: setupStoreWithNoRow(),
          skillStore,
          skillsRepoPath: skillsPath,
          bootstrapLock: passLock,
          toolchain,
        },
        { kind: "own", direction: "adopt", remoteUrl },
      );

      expect(result.isOk()).toBe(true);
      expect(await git(skillsPath, "rev-parse", "refs/heads/main^")).toBe(
        await tx((trx) => skillStore.getLayoutCommitSha(trx)),
      );
      expect(await readMainSha(remotePath)).toBe(remoteSha);
    } finally {
      await close();
    }
  });

  it("own + adopt over the bare layout commit changes nothing when its fetch fails", {
    timeout: 30_000,
  }, async () => {
    const { tx, close } = await createTestDatabase();
    try {
      const skillStore = new DrizzleSkillStore();
      const skillsPath = join(workDir, "skills.git");
      await bootstrapSkillsRepo({ path: skillsPath });
      const bare = await migrateSkillsLayout({ runInTx: tx, store: skillStore }, skillsPath);
      // The fetch's update of the side ref is aborted; its deletion passes.
      await writeFile(
        join(skillsPath, "hooks", "reference-transaction"),
        "#!/bin/sh\n[ \"$1\" = prepared ] || exit 0\nexec awk '$3 ~ /^refs\\/cogmo\\/adopt-main-/ && $2 !~ /^0+$/ { f = 1 } END { exit f }'\n",
        { mode: 0o755 },
      );
      const remoteUrl = await makePopulatedRemote();

      const result = await configureSkillsRemote(
        {
          runInTx: tx,
          codingStore: setupStoreWithNoRow(),
          skillStore,
          skillsRepoPath: skillsPath,
          bootstrapLock: passLock,
          toolchain,
        },
        { kind: "own", direction: "adopt", remoteUrl },
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.kind).toBe("remote_unreachable");
      expect(await readMainSha(skillsPath)).toBe(bare);
      expect(await tx((trx) => skillStore.getLayoutCommitSha(trx))).toBe(bare);
      expect(
        (await execFileP("git", ["-C", skillsPath, "for-each-ref", "refs/cogmo/"])).stdout,
      ).toBe("");
    } finally {
      await close();
    }
  });

  it("own + adopt over the bare layout commit fetches to a side ref of its own", {
    timeout: 30_000,
  }, async () => {
    const { tx, close } = await createTestDatabase();
    try {
      const skillStore = new DrizzleSkillStore();
      const skillsPath = join(workDir, "skills.git");
      await bootstrapSkillsRepo({ path: skillsPath });
      const bare = await migrateSkillsLayout({ runInTx: tx, store: skillStore }, skillsPath);
      // Another write under refs/cogmo/ lands right after this adopt's fetch
      // commits its own ref; the hook logs every ref written there.
      const theirs = "refs/cogmo/adopt-main";
      const written = join(workDir, "cogmo-refs.log");
      await writeFile(
        join(skillsPath, "hooks", "reference-transaction"),
        `#!/bin/sh\n[ "$1" = committed ] || exit 0\nawk -v out=${written} '$3 ~ /^refs\\/cogmo\\// && $2 !~ /^0+$/ { print $3 >> out; if ($2 != "${bare}") f = 1 } END { exit !f }' && git update-ref ${theirs} ${bare}\nexit 0\n`,
        { mode: 0o755 },
      );
      const remoteUrl = await makePopulatedRemote();
      const remoteSha = await readMainSha(remoteUrl.replace("file://", ""));

      const result = await configureSkillsRemote(
        {
          runInTx: tx,
          codingStore: setupStoreWithNoRow(),
          skillStore,
          skillsRepoPath: skillsPath,
          bootstrapLock: passLock,
          toolchain,
        },
        { kind: "own", direction: "adopt", remoteUrl },
      );

      expect(result.isOk()).toBe(true);
      const layout = await tx((trx) => skillStore.getLayoutCommitSha(trx));
      expect(await git(skillsPath, "rev-parse", `${layout}^`)).toBe(remoteSha);
      // The adopt fetched to a ref of its own, named for it alone, and left
      // the other write's ref for its writer to resolve and delete.
      const [own, ...rest] = (await readFile(written, "utf8")).trim().split("\n");
      expect(own).toMatch(
        /^refs\/cogmo\/adopt-main-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(rest).toEqual([theirs]);
      expect(
        (
          await execFileP("git", [
            "-C",
            skillsPath,
            "for-each-ref",
            "--format=%(refname)",
            "refs/cogmo/",
          ])
        ).stdout.trim(),
      ).toBe(theirs);
    } finally {
      await close();
    }
  });

  it("own + adopt replaces a main holding the bare layout and toolchain commits", {
    timeout: 30_000,
  }, async () => {
    const { tx, close } = await createTestDatabase();
    try {
      const skillStore = new DrizzleSkillStore();
      const skillsPath = join(workDir, "skills.git");
      await bootstrapSkillsRepo({ path: skillsPath });
      // The boot on an unborn main: the layout move, then the toolchain commit.
      const bare = await migrateSkillsLayout({ runInTx: tx, store: skillStore }, skillsPath);
      await commitToolchain({ runInTx: tx, store: skillStore }, skillsPath, toolchain);
      const remoteUrl = await makePopulatedRemote();
      const remoteSha = await readMainSha(remoteUrl.replace("file://", ""));

      const result = await configureSkillsRemote(
        {
          runInTx: tx,
          codingStore: setupStoreWithNoRow(),
          skillStore,
          skillsRepoPath: skillsPath,
          bootstrapLock: passLock,
          toolchain,
        },
        { kind: "own", direction: "adopt", remoteUrl },
      );

      expect(result.isOk()).toBe(true);
      const layout = await tx((trx) => skillStore.getLayoutCommitSha(trx));
      expect(layout).not.toBe(bare);
      expect(await git(skillsPath, "rev-parse", `${layout}^`)).toBe(remoteSha);
      expect(await git(skillsPath, "rev-parse", "refs/heads/main^")).toBe(layout);
      expect(await readMainSha(remoteUrl.replace("file://", ""))).toBe(
        await readMainSha(skillsPath),
      );
    } finally {
      await close();
    }
  });

  it("own + adopt classifies main under the bootstrap lock and holds it through the toolchain commit", {
    timeout: 30_000,
  }, async () => {
    const { tx, close } = await createTestDatabase();
    try {
      const skillStore = new DrizzleSkillStore();
      const skillsPath = join(workDir, "skills.git");
      await bootstrapSkillsRepo({ path: skillsPath });
      const remoteUrl = await makePopulatedRemote();
      const remoteSha = await readMainSha(remoteUrl.replace("file://", ""));
      // A boot holds the lock first and leaves main Cogmo-only; read unlocked,
      // main would still be unborn and the adopt a fast-forward that loses.
      let taken = 0;
      let mainAtRelease: string | null = null;
      const bootFirst: BootstrapLock = async (fn) => {
        taken += 1;
        await migrateSkillsLayout({ runInTx: tx, store: skillStore }, skillsPath);
        await commitToolchain({ runInTx: tx, store: skillStore }, skillsPath, toolchain);
        try {
          return await fn();
        } finally {
          mainAtRelease = await readMainSha(skillsPath);
        }
      };

      const result = await configureSkillsRemote(
        {
          runInTx: tx,
          codingStore: setupStoreWithNoRow(),
          skillStore,
          skillsRepoPath: skillsPath,
          bootstrapLock: bootFirst,
          toolchain,
        },
        { kind: "own", direction: "adopt", remoteUrl },
      );

      expect(result.isOk()).toBe(true);
      expect(taken).toBe(1);
      const main = await readMainSha(skillsPath);
      expect(mainAtRelease).toBe(main);
      expect(
        await git(
          skillsPath,
          "log",
          "-1",
          "--format=%(trailers:key=Cogmo-Toolchain,valueonly)",
          expectDefined(main, "main"),
        ),
      ).toBe("9.9.9");
      expect(await git(skillsPath, "rev-parse", "refs/heads/main^^")).toBe(remoteSha);
    } finally {
      await close();
    }
  });

  it("own + adopt fetches the remote's main to its side ref before taking the bootstrap lock", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makePopulatedRemote();
    const remoteSha = await readMainSha(remoteUrl.replace("file://", ""));
    // What the side refs hold when the lock is taken: a fetch run under the
    // lock would hold it for as long as the remote hangs.
    const atLock: string[] = [];
    const watchLock: BootstrapLock = async (fn) => {
      atLock.push(await git(skillsPath, "for-each-ref", "--format=%(objectname)", "refs/cogmo/"));
      return fn();
    };

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore: setupStoreWithNoRow(),
        skillsRepoPath: skillsPath,
        bootstrapLock: watchLock,
        toolchain,
      },
      { kind: "own", direction: "adopt", remoteUrl },
    );

    expect(result.isOk()).toBe(true);
    expect(atLock).toEqual([remoteSha]);
    expect(await readMainSha(skillsPath)).toBe(remoteSha);
    expect(await git(skillsPath, "for-each-ref", "refs/cogmo/")).toBe("");
  });

  it("own + adopt over a Cogmo-only main refuses, without taking the bootstrap lock, a remote list naming an entry the toolchain may not own", {
    timeout: 30_000,
  }, async () => {
    const { tx, close } = await createTestDatabase();
    try {
      const skillStore = new DrizzleSkillStore();
      const skillsPath = join(workDir, "skills.git");
      await bootstrapSkillsRepo({ path: skillsPath });
      const bare = await migrateSkillsLayout({ runInTx: tx, store: skillStore }, skillsPath);
      await commitToolchain({ runInTx: tx, store: skillStore }, skillsPath, toolchain);
      const before = await readMainSha(skillsPath);
      const remoteUrl = await makeRemoteWith({ ".cogmo/paths": "pyproject.toml\nskills\n" });
      const { lock, taken } = countingLock();

      const result = await configureSkillsRemote(
        {
          runInTx: tx,
          codingStore: setupStoreWithNoRow(),
          skillStore,
          skillsRepoPath: skillsPath,
          bootstrapLock: lock,
          toolchain,
        },
        { kind: "own", direction: "adopt", remoteUrl },
      );

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: "remote_toolchain_invalid",
        remoteUrl,
        entry: "skills",
      });
      expect(taken()).toBe(0);
      expect(await readMainSha(skillsPath)).toBe(before);
      expect(await tx((trx) => skillStore.getLayoutCommitSha(trx))).toBe(bare);
      expect(await readOrigin(skillsPath)).toBeNull();
      expect(await git(skillsPath, "for-each-ref", "refs/cogmo/")).toBe("");
    } finally {
      await close();
    }
  });

  it("own + adopt refuses, before main moves, a fast-forward to a remote list naming a skill file", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makeRemoteWith({
      ".cogmo/paths": "pyproject.toml\nskill.py\n.cogmo\n",
    });

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore: setupStoreWithNoRow(),
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "adopt", remoteUrl },
    );

    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "remote_toolchain_invalid",
      remoteUrl,
      entry: "skill.py",
    });
    expect(await readMainSha(skillsPath)).toBeNull();
    expect(await readOrigin(skillsPath)).toBeNull();
    expect(await git(skillsPath, "for-each-ref", "refs/cogmo/")).toBe("");
  });

  it("own + adopt fast-forwards a populated local main to the remote's descendant", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makeRemoteWith({ "README.md": "v1\n" });
    const remotePath = remoteUrl.replace("file://", "");
    const deps = {
      runInTx: fakeRunInTx,
      skillStore: mock<SkillStore>(),
      codingStore: setupStoreWithNoRow(),
      skillsRepoPath: skillsPath,
      bootstrapLock: passLock,
      toolchain,
    };
    expect(
      (await configureSkillsRemote(deps, { kind: "own", direction: "adopt", remoteUrl })).isOk(),
    ).toBe(true);
    const first = await readMainSha(skillsPath);
    // The remote moves on from what local main holds.
    const work = await mkdtemp(join(tmpdir(), "configure-remote-advance-"));
    try {
      await execFileP("git", ["clone", "-q", remotePath, work]);
      await writeFile(join(work, "README.md"), "v2\n");
      await execFileP("git", [
        "-C",
        work,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-qam",
        "v2",
      ]);
      await git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
    } finally {
      await rm(work, { recursive: true, force: true });
    }

    const result = await configureSkillsRemote(deps, {
      kind: "own",
      direction: "adopt",
      remoteUrl,
    });

    expect(result.isOk()).toBe(true);
    const main = await readMainSha(skillsPath);
    expect(main).toBe(await readMainSha(remotePath));
    expect(await git(skillsPath, "rev-parse", `${main}^`)).toBe(first);
  });

  it("own + adopt is remote_diverged, keeping the deploy, when a deploy lands during its fetch", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makeRemoteWith({ "README.md": "v1\n" });
    const deps = {
      runInTx: fakeRunInTx,
      skillStore: mock<SkillStore>(),
      codingStore: setupStoreWithNoRow(),
      skillsRepoPath: skillsPath,
      bootstrapLock: passLock,
      toolchain,
    };
    expect(
      (await configureSkillsRemote(deps, { kind: "own", direction: "adopt", remoteUrl })).isOk(),
    ).toBe(true);
    const adopted = expectDefined(await readMainSha(skillsPath), "main");
    // A deploy lands as the second adopt's fetch commits its side ref, before
    // the adopt takes the lock and classifies main.
    const tree = await git(skillsPath, "rev-parse", `${adopted}^{tree}`);
    const deploy = (
      await execFileP(
        "git",
        ["-C", skillsPath, "commit-tree", tree, "-p", adopted, "-m", "deploy"],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        },
      )
    ).stdout.trim();
    await writeFile(
      join(skillsPath, "hooks", "reference-transaction"),
      `#!/bin/sh\n[ "$1" = committed ] || exit 0\ngrep -q ' refs/cogmo/adopt-main-' && git update-ref refs/heads/main ${deploy}\nexit 0\n`,
      { mode: 0o755 },
    );

    const result = await configureSkillsRemote(deps, {
      kind: "own",
      direction: "adopt",
      remoteUrl,
    });

    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "remote_diverged", localSha: deploy });
    expect(await readMainSha(skillsPath)).toBe(deploy);
    expect(await git(skillsPath, "for-each-ref", "refs/cogmo/")).toBe("");
  });

  it("own + adopt is remote_diverged when a register holds main at its fast-forward", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makeRemoteWith({ "README.md": "v1\n" });
    const remotePath = remoteUrl.replace("file://", "");
    const local = await git(remotePath, "rev-parse", "refs/heads/main^");
    await git(skillsPath, "fetch", "-q", remotePath, `${local}:refs/heads/main`);
    // A register's update-ref holds main's ref lock once the adopt has
    // classified main, so the adopt's compare-and-swap cannot take it.
    const mainLock = join(skillsPath, "refs", "heads", "main.lock");
    const registerHolds: BootstrapLock = async (fn) => {
      await writeFile(mainLock, "");
      try {
        return await fn();
      } finally {
        await rm(mainLock, { force: true });
      }
    };

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore: setupStoreWithNoRow(),
        skillsRepoPath: skillsPath,
        bootstrapLock: registerHolds,
        toolchain,
      },
      { kind: "own", direction: "adopt", remoteUrl },
    );

    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "remote_diverged", localSha: local });
    expect(await readMainSha(skillsPath)).toBe(local);
    expect(await git(skillsPath, "for-each-ref", "refs/cogmo/")).toBe("");
  });

  it("own + publish counts a Cogmo-only main as empty", { timeout: 30_000 }, async () => {
    const { tx, close } = await createTestDatabase();
    try {
      const skillStore = new DrizzleSkillStore();
      const skillsPath = join(workDir, "skills.git");
      await bootstrapSkillsRepo({ path: skillsPath });
      await migrateSkillsLayout({ runInTx: tx, store: skillStore }, skillsPath);
      await commitToolchain({ runInTx: tx, store: skillStore }, skillsPath, toolchain);
      const remoteUrl = await makeEmptyRemote();

      const result = await configureSkillsRemote(
        {
          runInTx: tx,
          codingStore: setupStoreWithNoRow(),
          skillStore,
          skillsRepoPath: skillsPath,
          bootstrapLock: passLock,
          toolchain,
        },
        { kind: "own", direction: "publish", remoteUrl },
      );

      expect(result._unsafeUnwrapErr()).toEqual({ kind: "local_empty", remoteUrl });
      expect(await readMainSha(remoteUrl.replace("file://", ""))).toBeNull();
    } finally {
      await close();
    }
  });

  it("own + publish pushes a populated local to an empty remote without taking the bootstrap lock", async () => {
    // Operator has local skills + fresh empty remote: publish must push
    // local to remote, not fetch. Asserts the data-loss-free direction
    // for the populated-local case. The push only reads main, so a remote
    // that hangs holds no lock a boot waits on.
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const localSha = await seedSkillsBare(skillsPath);
    const remoteUrl = await makeEmptyRemote();
    const remotePath = remoteUrl.replace("file://", "");
    const codingStore = setupStoreWithNoRow();
    const { lock, taken } = countingLock();

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore,
        skillsRepoPath: skillsPath,
        bootstrapLock: lock,
        toolchain,
      },
      { kind: "own", direction: "publish", remoteUrl },
    );

    expect(result.isOk()).toBe(true);
    expect(taken()).toBe(0);
    if (result.isOk() && result.value.kind === "configured") {
      expect(result.value.direction).toBe("publish");
      expect(result.value.originAction).toBe("attached");
      expect(result.value.ensured.kind).toBe("created");
    }
    expect(await readOrigin(skillsPath)).toBe(remoteUrl);
    // Crux: the remote received the local SHA — no data loss, and local
    // wasn't overwritten by a fetch.
    expect(await readMainSha(remotePath)).toBe(localSha);
    expect(await readMainSha(skillsPath)).toBe(localSha);
  });

  it("own + publish is remote_unreachable when the remote refuses the push for another reason", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    await seedSkillsBare(skillsPath);
    const remoteUrl = await makeEmptyRemote();
    const remotePath = remoteUrl.replace("file://", "");
    await writeFile(join(remotePath, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore: setupStoreWithNoRow(),
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "publish", remoteUrl },
    );

    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "remote_unreachable",
      remoteUrl,
      reason: expect.stringContaining("pre-receive hook declined"),
    });
    expect(await readMainSha(remotePath)).toBeNull();
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own + adopt refuses to overwrite divergent local commits (remote_diverged)", async () => {
    // Local has commits; remote has unrelated commits. Adopt would
    // orphan local. The fast-forward fetch must refuse and leave local
    // main untouched — the safety property the diverged variant exists
    // to enforce.
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const localSha = await seedSkillsBare(skillsPath, "local-only commit");
    const remoteUrl = await makePopulatedRemote(); // unrelated history
    const codingStore = setupStoreWithNoRow();

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore,
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "adopt", remoteUrl },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("remote_diverged");
    // Local main must be untouched — fast-forward fetch's rejection is
    // the data-loss-safety guarantee the diverged variant encodes.
    expect(await readMainSha(skillsPath)).toBe(localSha);
  });

  it("own + publish refuses to overwrite divergent remote commits (local_diverged)", async () => {
    // Inverse of remote_diverged: local and remote have unrelated
    // histories, operator selects publish. Push must refuse, remote
    // must be untouched.
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    await seedSkillsBare(skillsPath, "local-only commit");
    const remoteUrl = await makePopulatedRemote();
    const remotePath = remoteUrl.replace("file://", "");
    const remoteShaBefore = await readMainSha(remotePath);
    const codingStore = setupStoreWithNoRow();

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore,
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "publish", remoteUrl },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("local_diverged");
    // Remote main is untouched.
    expect(await readMainSha(remotePath)).toBe(remoteShaBefore);
  });

  it("own returns remote_unreachable for a parseable URL pointing at nothing", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const nonexistent = `file://${join(workDir, "owner", "does-not-exist.git")}`;

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore: setupStoreWithNoRow(),
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "adopt", remoteUrl: nonexistent },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("remote_unreachable");
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own + adopt is idempotent — second invocation with same URL yields unchanged", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makePopulatedRemote();

    // Track storedRow in a closure so the second pass reads the inserted row.
    let storedRow: CodingRepoRow | undefined;
    const codingStore = mock<CodingStore>();
    codingStore.getRepoByName.mockImplementation(async () => storedRow);
    codingStore.insertOrRecoverRepo.mockImplementation(async (_tx, params) => {
      storedRow = rowFromParams(params);
      return { kind: "new", row: storedRow };
    });

    const first = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore,
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "adopt", remoteUrl },
    );
    expect(first._unsafeUnwrap()).toMatchObject({
      kind: "configured",
      ensured: { kind: "created" },
    });

    // Second pass: local now has main matching remote. Adopt still works
    // because fast-forward fetch is a no-op when local already equals
    // remote.
    const second = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore,
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
      },
      { kind: "own", direction: "adopt", remoteUrl },
    );

    expect(second.isOk()).toBe(true);
    if (second.isOk() && second.value.kind === "configured") {
      expect(second.value.originAction).toBe("unchanged");
      expect(second.value.ensured.kind).toBe("unchanged");
    }
    expect(codingStore.updateRepoRemoteUrl).not.toHaveBeenCalled();
  });

  it("auto-provision picks adopt + auto_init:true when local is empty", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    // Pre-create the "GitHub repo" Cogmo will think it created, with a
    // README seed (mirrors `auto_init: true` server-side behavior).
    const remoteUrl = await makePopulatedRemote("github-stub");

    const createSpy = vi.fn().mockResolvedValue({ data: { clone_url: remoteUrl } });
    const fakeOctokit = { repos: { createForAuthenticatedUser: createSpy } };

    const codingStore = setupStoreWithNoRow();
    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore,
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
        octokitFactory: () => fakeOctokit as unknown as Octokit,
      },
      { kind: "auto-provision", identity: FAKE_IDENTITY },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.kind === "configured") {
      expect(result.value.direction).toBe("adopt");
    }
    // Cogmo asked for a seeded repo (auto_init: true) so it has main to
    // adopt — the data-loss-free fresh-install path.
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cogmo-skills", auto_init: true, private: true }),
    );
  });

  it("auto-provision over the bare layout commit picks adopt + auto_init:true", {
    timeout: 30_000,
  }, async () => {
    const { tx, close } = await createTestDatabase();
    try {
      const skillStore = new DrizzleSkillStore();
      const skillsPath = join(workDir, "skills.git");
      await bootstrapSkillsRepo({ path: skillsPath });
      await migrateSkillsLayout({ runInTx: tx, store: skillStore }, skillsPath);
      const remoteUrl = await makePopulatedRemote("github-stub");
      const createSpy = vi.fn().mockResolvedValue({ data: { clone_url: remoteUrl } });

      const result = await configureSkillsRemote(
        {
          runInTx: tx,
          skillStore,
          codingStore: setupStoreWithNoRow(),
          skillsRepoPath: skillsPath,
          bootstrapLock: passLock,
          toolchain,
          octokitFactory: () =>
            ({ repos: { createForAuthenticatedUser: createSpy } }) as unknown as Octokit,
        },
        { kind: "auto-provision", identity: FAKE_IDENTITY },
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk() && result.value.kind === "configured") {
        expect(result.value.direction).toBe("adopt");
      }
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ auto_init: true }));
    } finally {
      await close();
    }
  });

  it("auto-provision picks publish + auto_init:false when local has commits", async () => {
    // Local already has skills. Auto-provision must NOT request a
    // README-seeded remote that would overwrite local main — Cogmo asks
    // GitHub for an empty repo and pushes local to it instead. Asserts
    // both the `auto_init:false` API call shape and the post-condition
    // (local SHA survives + lands on the remote).
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const localSha = await seedSkillsBare(skillsPath, "operator's local skill");
    const remoteUrl = await makeEmptyRemote("github-stub", "fresh.git");
    const remotePath = remoteUrl.replace("file://", "");

    const createSpy = vi.fn().mockResolvedValue({ data: { clone_url: remoteUrl } });
    const fakeOctokit = { repos: { createForAuthenticatedUser: createSpy } };

    const codingStore = setupStoreWithNoRow();
    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore,
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
        octokitFactory: () => fakeOctokit as unknown as Octokit,
      },
      { kind: "auto-provision", identity: FAKE_IDENTITY },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.kind === "configured") {
      expect(result.value.direction).toBe("publish");
    }
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cogmo-skills", auto_init: false, private: true }),
    );
    // Local skill survives + remote received the push — no data loss.
    expect(await readMainSha(skillsPath)).toBe(localSha);
    expect(await readMainSha(remotePath)).toBe(localSha);
  });

  it("auto-provision surfaces auto_provision_repo_exists on 422", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const { RequestError } = await import("@octokit/request-error");

    const fakeOctokit = {
      repos: {
        createForAuthenticatedUser: vi.fn().mockImplementation(async () => {
          throw new RequestError("Validation failed", 422, {
            response: {
              status: 422,
              url: "https://api.github.com/user/repos",
              headers: {},
              data: {},
            },
            request: { method: "POST", url: "https://api.github.com/user/repos", headers: {} },
          });
        }),
      },
    };

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        skillStore: mock<SkillStore>(),
        codingStore: setupStoreWithNoRow(),
        skillsRepoPath: skillsPath,
        bootstrapLock: passLock,
        toolchain,
        // Partial Octokit stub — only `createForAuthenticatedUser` is exercised.
        octokitFactory: () => fakeOctokit as unknown as Octokit,
      },
      { kind: "auto-provision", identity: FAKE_IDENTITY },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.kind === "auto_provision_repo_exists") {
      expect(result.error.repoName).toBe("cogmo-skills");
    }
    expect(fakeOctokit.repos.createForAuthenticatedUser).toHaveBeenCalledTimes(1);
    expect(await readOrigin(skillsPath)).toBeNull();
  });
});
