import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { mirrorMainBestEffort, mirrorMainToRemote } from "./mirror.js";

const execFileP = promisify(execFile);

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("mirrorMainToRemote", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("logs a failed origin lookup instead of throwing after a committed deploy", async () => {
    // Not a git repository: `git remote get-url origin` fails with a code
    // other than the "no such remote" one, which the lookup rethrows.
    dir = await mkdtemp(join(tmpdir(), "cogmo-mirror-test-"));
    await expect(
      mirrorMainToRemote(
        { runInTx: fakeRunInTx, secretsStore: mock<SecretsStore>() },
        dir,
        "0123456789abcdef0123456789abcdef01234567",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("mirrorMainBestEffort", () => {
  it("logs a repo it cannot read rather than rejecting", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "boot-skills-mirror-none-"));
    try {
      await expect(
        mirrorMainBestEffort(
          { runInTx: fakeRunInTx, secretsStore: mock<SecretsStore>() },
          notARepo,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });

  it("pushes local main to origin, and skips an unborn main", async () => {
    const root = await mkdtemp(join(tmpdir(), "boot-skills-mirror-"));
    try {
      const local = join(root, "skills.git");
      const remote = join(root, "remote.git");
      const git = (...args: string[]) => execFileP("git", args);
      await git("init", "-q", "--bare", "--initial-branch=main", local);
      await git("init", "-q", "--bare", "--initial-branch=main", remote);
      await git("-C", local, "remote", "add", "origin", remote);
      const deps = { runInTx: fakeRunInTx, secretsStore: mock<SecretsStore>() };

      await mirrorMainBestEffort(deps, local);
      await expect(git("-C", remote, "rev-parse", "--verify", "refs/heads/main")).rejects.toThrow();

      const tree = (
        await git("-C", local, "hash-object", "-t", "tree", "-w", "/dev/null")
      ).stdout.trim();
      const commit = (
        await execFileP("git", ["-C", local, "commit-tree", tree, "-m", "layout"], {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        })
      ).stdout.trim();
      await git("-C", local, "update-ref", "refs/heads/main", commit);

      await mirrorMainBestEffort(deps, local);

      expect((await git("-C", remote, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(commit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
