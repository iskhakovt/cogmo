import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteRef,
  GitOpsError,
  getMainSha,
  gitShow,
  isAncestor,
  revParse,
  updateRef,
} from "./git-ops.js";

const execFileP = promisify(execFile);

/**
 * Build a real bare repo + a working clone with two commits on `feat`. Returns
 * both paths plus the two commit SHAs. The bare repo is what Cogmo operates
 * on; the work repo simulates the agent's worktree.
 */
async function makeRepos(): Promise<{
  bare: string;
  work: string;
  shaA: string;
  shaB: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "skills-git-ops-"));
  const bare = join(root, "bare.git");
  const work = join(root, "work");
  await mkdir(bare);
  await mkdir(work);

  await execFileP("git", ["init", "--bare", bare]);
  await execFileP("git", ["init", "-b", "main", work]);
  await execFileP("git", ["-C", work, "config", "user.email", "test@cogmo.dev"]);
  await execFileP("git", ["-C", work, "config", "user.name", "test"]);
  await execFileP("git", ["-C", work, "config", "commit.gpgsign", "false"]);
  await execFileP("git", ["-C", work, "remote", "add", "origin", bare]);

  await writeFile(join(work, "SKILL.md"), "first\n");
  await execFileP("git", ["-C", work, "add", "."]);
  await execFileP("git", ["-C", work, "commit", "-m", "first"]);
  const shaA = (await execFileP("git", ["-C", work, "rev-parse", "HEAD"])).stdout.trim();

  await writeFile(join(work, "SKILL.md"), "second\n");
  await execFileP("git", ["-C", work, "add", "."]);
  await execFileP("git", ["-C", work, "commit", "-m", "second"]);
  const shaB = (await execFileP("git", ["-C", work, "rev-parse", "HEAD"])).stdout.trim();

  // Push to bare under feat/branch (not main — the pre-receive hook in
  // production rejects pushes to main; this test repo doesn't install the
  // hook but we mirror the real flow).
  await execFileP("git", ["-C", work, "push", "origin", "main:refs/heads/feat"]);

  return { bare, work, shaA, shaB };
}

describe("git-ops", () => {
  let cleanup: string[] = [];

  beforeEach(() => {
    cleanup = [];
  });

  afterEach(async () => {
    for (const path of cleanup) {
      await rm(path, { recursive: true, force: true });
    }
  });

  describe("revParse", () => {
    it("resolves a branch ref to a sha", async () => {
      const { bare, work, shaB } = await makeRepos();
      cleanup.push(bare, work);
      expect(await revParse(bare, "refs/heads/feat")).toBe(shaB);
    });

    it("throws ref_not_found for an unknown ref", async () => {
      const { bare, work } = await makeRepos();
      cleanup.push(bare, work);
      await expect(revParse(bare, "refs/heads/missing")).rejects.toMatchObject({
        code: "ref_not_found",
      });
    });
  });

  describe("gitShow", () => {
    it("reads a file at a specific sha", async () => {
      const { bare, work, shaA, shaB } = await makeRepos();
      cleanup.push(bare, work);
      expect(await gitShow(bare, shaA, "SKILL.md")).toBe("first\n");
      expect(await gitShow(bare, shaB, "SKILL.md")).toBe("second\n");
    });

    it("throws file_not_found when the path is missing at that sha", async () => {
      const { bare, work, shaA } = await makeRepos();
      cleanup.push(bare, work);
      await expect(gitShow(bare, shaA, "MISSING.md")).rejects.toMatchObject({
        code: "file_not_found",
      });
    });

    it("throws ref_not_found for an invalid sha", async () => {
      const { bare, work } = await makeRepos();
      cleanup.push(bare, work);
      await expect(
        gitShow(bare, "0000000000000000000000000000000000000000", "SKILL.md"),
      ).rejects.toBeInstanceOf(GitOpsError);
    });
  });

  describe("isAncestor", () => {
    it("returns true when ancestor is reachable from descendant", async () => {
      const { bare, work, shaA, shaB } = await makeRepos();
      cleanup.push(bare, work);
      expect(await isAncestor(bare, shaA, shaB)).toBe(true);
    });

    it("returns false when ancestor is not reachable", async () => {
      const { bare, work, shaA, shaB } = await makeRepos();
      cleanup.push(bare, work);
      expect(await isAncestor(bare, shaB, shaA)).toBe(false);
    });
  });

  describe("updateRef + getMainSha", () => {
    it("getMainSha returns null when main does not exist", async () => {
      const { bare, work } = await makeRepos();
      cleanup.push(bare, work);
      expect(await getMainSha(bare)).toBeNull();
    });

    it("creates main on first update with empty expectedOldSha", async () => {
      const { bare, work, shaA } = await makeRepos();
      cleanup.push(bare, work);
      await updateRef(bare, "refs/heads/main", shaA, "0000000000000000000000000000000000000000");
      expect(await getMainSha(bare)).toBe(shaA);
    });

    it("advances main with CAS check matching prior sha", async () => {
      const { bare, work, shaA, shaB } = await makeRepos();
      cleanup.push(bare, work);
      await updateRef(bare, "refs/heads/main", shaA, "0000000000000000000000000000000000000000");
      await updateRef(bare, "refs/heads/main", shaB, shaA);
      expect(await getMainSha(bare)).toBe(shaB);
    });

    it("throws ref_changed when CAS check fails", async () => {
      const { bare, work, shaA, shaB } = await makeRepos();
      cleanup.push(bare, work);
      await updateRef(bare, "refs/heads/main", shaA, "0000000000000000000000000000000000000000");
      await expect(
        updateRef(bare, "refs/heads/main", shaB, "0000000000000000000000000000000000000000"),
      ).rejects.toMatchObject({ code: "ref_changed" });
    });
  });

  describe("deleteRef", () => {
    it("removes an existing ref", async () => {
      const { bare, work } = await makeRepos();
      cleanup.push(bare, work);
      await deleteRef(bare, "refs/heads/feat");
      await expect(revParse(bare, "refs/heads/feat")).rejects.toMatchObject({
        code: "ref_not_found",
      });
    });

    it("is a no-op on a missing ref", async () => {
      const { bare, work } = await makeRepos();
      cleanup.push(bare, work);
      await expect(deleteRef(bare, "refs/heads/missing")).resolves.toBeUndefined();
    });

    it("refuses refs/heads/main (defense in depth against caller bugs)", async () => {
      const { bare, work, shaA } = await makeRepos();
      cleanup.push(bare, work);
      await updateRef(bare, "refs/heads/main", shaA, "0000000000000000000000000000000000000000");
      await expect(deleteRef(bare, "refs/heads/main")).rejects.toMatchObject({
        code: "exec_failed",
        message: expect.stringMatching(/refuses to delete refs\/heads\/main/),
      });
      // main still exists.
      expect(await revParse(bare, "refs/heads/main")).toBe(shaA);
    });

    it("refuses bare 'main' too", async () => {
      const { bare, work } = await makeRepos();
      cleanup.push(bare, work);
      await expect(deleteRef(bare, "main")).rejects.toMatchObject({
        code: "exec_failed",
        message: expect.stringMatching(/refuses to delete refs\/heads\/main/),
      });
    });
  });
});
