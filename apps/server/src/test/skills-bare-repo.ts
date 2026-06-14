/**
 * Test fixtures for the skills bare repo / remote test surface. Both
 * `configure-remote.test.ts` and `runner.register.test.ts` need on-disk
 * bare repos with seed commits to exercise direction-aware transfer and
 * register mirror paths against real git semantics. The primitives here
 * are shared so a future shape change (e.g. seeding with multiple
 * commits, or configuring the pre-receive hook differently) updates
 * exactly one place.
 *
 * Each helper takes a `parentDir` and writes under it — callers own
 * cleanup via `rm(parentDir, { recursive: true, force: true })`.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface BareRepoFixture {
  /** Absolute path of the bare repo on disk. */
  path: string;
  /** `file://`-form URL that `parseRemoteUrl` will accept (owner/repo path segments). */
  url: string;
}

/**
 * Create a bare repo at `<parentDir>/<subdir>/<name>` with one seed commit
 * on `refs/heads/main`. The owner/repo segment shape makes the resulting
 * `file://` URL parse cleanly via `src/agent/coding/open-pr.ts:parseRemoteUrl`.
 */
export async function makePopulatedBareRepo(
  parentDir: string,
  subdir = "owner",
  name = "repo.git",
): Promise<BareRepoFixture> {
  const path = join(parentDir, subdir, name);
  await mkdir(dirname(path), { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", path]);
  // Bare repos can't commit directly — seed via a temp working clone.
  const seed = await mkdtemp(join(tmpdir(), "skills-bare-seed-"));
  try {
    await execFileP("git", ["init", "-b", "main", seed]);
    await execFileP("git", ["-C", seed, "config", "user.email", "seed@test"]);
    await execFileP("git", ["-C", seed, "config", "user.name", "seed"]);
    await execFileP("git", ["-C", seed, "config", "commit.gpgsign", "false"]);
    await execFileP("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"]);
    await execFileP("git", ["-C", seed, "push", path, "main:refs/heads/main"]);
  } finally {
    await rm(seed, { recursive: true, force: true });
  }
  return { path, url: `file://${path}` };
}

/**
 * Create an empty bare repo at `<parentDir>/<subdir>/<name>` — `git init
 * --bare` with no seed commit. `refs/heads/main` is unborn until something
 * writes to it.
 */
export async function makeEmptyBareRepo(
  parentDir: string,
  subdir = "owner",
  name = "empty.git",
): Promise<BareRepoFixture> {
  const path = join(parentDir, subdir, name);
  await mkdir(dirname(path), { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", path]);
  return { path, url: `file://${path}` };
}
