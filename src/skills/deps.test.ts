import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REQUIREMENTS_LOCK_FILE, readLockfileAtSha } from "./deps.js";
import { bootstrapSkillsRepo } from "./repo.js";

const execFileP = promisify(execFile);

interface Setup {
  bare: string;
  work: string;
}

describe("readLockfileAtSha", () => {
  let setup: Setup;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "skills-deps-"));
    const bare = join(root, "skills.git");
    const work = join(root, "work");
    await bootstrapSkillsRepo({ path: bare });
    await execFileP("mkdir", [work]);
    await execFileP("git", ["init", "-b", "main", work]);
    await execFileP("git", ["-C", work, "config", "user.email", "test@cogmo.dev"]);
    await execFileP("git", ["-C", work, "config", "user.name", "test"]);
    await execFileP("git", ["-C", work, "config", "commit.gpgsign", "false"]);
    await execFileP("git", ["-C", work, "remote", "add", "origin", bare]);
    setup = { bare, work };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function commit(files: Record<string, string>): Promise<string> {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(setup.work, name), content);
    }
    await execFileP("git", ["-C", setup.work, "add", "."]);
    await execFileP("git", ["-C", setup.work, "commit", "-m", "test", "--allow-empty"]);
    const { stdout } = await execFileP("git", ["-C", setup.work, "rev-parse", "HEAD"]);
    return stdout.trim();
  }

  it("returns the sha256 hash and contents when the lockfile is present", async () => {
    const contents = "httpx==0.27.0 --hash=sha256:abc\n";
    const sha = await commit({ [REQUIREMENTS_LOCK_FILE]: contents });
    const result = await readLockfileAtSha(setup.work, sha);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.contents).toBe(contents);
    expect(result.value.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same hash for the same contents (deterministic)", async () => {
    const contents = "pydantic==2.5.3 --hash=sha256:def\n";
    const sha1 = await commit({ [REQUIREMENTS_LOCK_FILE]: contents, "extra.txt": "a" });
    const sha2 = await commit({ [REQUIREMENTS_LOCK_FILE]: contents, "extra.txt": "b" });
    const r1 = await readLockfileAtSha(setup.work, sha1);
    const r2 = await readLockfileAtSha(setup.work, sha2);
    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    if (!r1.isOk() || !r2.isOk()) return;
    expect(r1.value.hash).toBe(r2.value.hash);
  });

  it("returns 'missing' when the lockfile is not committed at this sha", async () => {
    // Fresh repo with zero lockfile history — avoids dependency on
    // commits left by earlier tests in the shared fixture.
    const dir = await mkdtemp(join(tmpdir(), "skills-deps-missing-"));
    try {
      await execFileP("git", ["init", "-b", "main", dir]);
      await execFileP("git", ["-C", dir, "config", "user.email", "test@cogmo.dev"]);
      await execFileP("git", ["-C", dir, "config", "user.name", "test"]);
      await execFileP("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
      await writeFile(join(dir, "other.txt"), "x");
      await execFileP("git", ["-C", dir, "add", "."]);
      await execFileP("git", ["-C", dir, "commit", "-m", "no lockfile"]);
      const { stdout } = await execFileP("git", ["-C", dir, "rev-parse", "HEAD"]);
      const result = await readLockfileAtSha(dir, stdout.trim());
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error.kind).toBe("missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 'empty' when the lockfile is committed but blank", async () => {
    const sha = await commit({ [REQUIREMENTS_LOCK_FILE]: "  \n\n" });
    const result = await readLockfileAtSha(setup.work, sha);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("empty");
  });
});
