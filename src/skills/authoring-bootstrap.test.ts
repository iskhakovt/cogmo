/**
 * End-to-end chain test for the skill-authoring boot path. Exercises the
 * three slices that have to compose correctly for `delegate_coding({ repo:
 * "skills" })` to round-trip on a fresh deployment:
 *
 *   1. `bootstrapSkillsRepo` pins the bare repo's HEAD to `refs/heads/main`
 *      (otherwise the `pre-receive` hook's main-gate doesn't apply and a
 *      pre-first-register clone gets an empty `master` worktree).
 *   2. `ensureSkillsCodingRepo` writes the `coding_repos` row that
 *      `delegate_coding` resolves by name (otherwise the agent hits "Repo
 *      not registered: skills" even though the bare repo is on disk).
 *   3. `fetchFeatureBranch` lands the feature branch under `refs/heads/*`
 *      when the local mirror is bare (otherwise `register_skill`'s
 *      `revParse(repoPath, "refs/heads/${branch}")` returns "not found"
 *      and the author's work is silently stranded).
 *
 * Each slice has its own unit test in `repo.test.ts` / `git-as-transport.test.ts`
 * / `runner.register.test.ts`. This test only adds value at the seam: a
 * regression in any one of the three would let those siloed tests still
 * pass while breaking the chain. The flow mirrors what happens in
 * production after a Daytona-backed task completes — the sandbox pushes a
 * feature branch to a remote, the host fetches it into the skill library
 * bare repo, then `register_skill` advances `main`.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { fetchFeatureBranch } from "../agent/coding/git-as-transport.js";
import { DrizzleCodingStore } from "../agent/coding/store/index.js";
import type { Database, Transactor } from "../db/index.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { GitHubIdentity } from "../secrets/github.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { bootstrapSkillsRepo, ensureSkillsCodingRepo, SKILLS_CODING_REPO_NAME } from "./repo.js";
import { SkillRunnerImpl } from "./runner.js";
import { DrizzleSkillStore } from "./store/index.js";

const execFileP = promisify(execFile);

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let codingStore: DrizzleCodingStore;
let skillStore: DrizzleSkillStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  codingStore = new DrizzleCodingStore();
  skillStore = new DrizzleSkillStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

const ECHO_MANIFEST = `---
name: hn_digest
description: a tier-1 skill that surfaces Hacker News top stories
tier: wasm
inputs:
  type: object
  properties:
    count:
      type: integer
  required: []
outputs:
  type: object
  properties:
    stories:
      type: array
      items:
        type: object
  required:
    - stories
---

# HN Digest
`;

const ECHO_BODY = `
async def run(inputs, ctx):
    return {"stories": []}
`;

// Local-only paths — `withGitAskpass` still runs, but git never invokes the
// askpass helper for a filesystem-path "remote", so the PAT is unused.
const fakeIdentity: GitHubIdentity = {
  pat: "ghp_unused_for_local_remote",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA",
  login: "test-bot",
  id: "12345",
};

interface Repos {
  /** The skill library bare repo — `$COGMO_SKILLS_PATH` in production. */
  skillsBare: string;
  /** Stand-in for the GitHub/Gitea remote that the sandbox pushes to. */
  daytonaRemoteBare: string;
  /** Working clone of `daytonaRemoteBare` — stand-in for the sandbox worktree. */
  sandboxWorktree: string;
  cleanup: () => Promise<void>;
}

async function setupRepos(): Promise<Repos> {
  const root = await mkdtemp(join(tmpdir(), "authoring-bootstrap-"));
  const skillsBare = join(root, "skills.git");
  const daytonaRemoteBare = join(root, "daytona-remote.git");
  const sandboxWorktree = join(root, "sandbox-worktree");

  // Skill library: production code path.
  await bootstrapSkillsRepo({ path: skillsBare });

  // Stand-in remote: just a bare repo on disk that the worktree pushes to.
  // In production this is the operator-attached GitHub/Gitea URL.
  await execFileP("git", ["init", "--bare", "--initial-branch=main", daytonaRemoteBare]);

  // Attach the stand-in remote as origin on the skills bare repo. In
  // production this is the wizard / `cogmo migrate skills-remote` step;
  // `ensureSkillsCodingRepo` reads this origin to fill `coding_repos.remote_url`.
  await execFileP("git", ["-C", skillsBare, "remote", "add", "origin", daytonaRemoteBare]);

  // Worktree the "sandbox" commits in. Configure a hermetic identity so
  // commits are deterministic across machines.
  await mkdir(sandboxWorktree);
  await execFileP("git", ["init", "-b", "main", sandboxWorktree]);
  await execFileP("git", ["-C", sandboxWorktree, "config", "user.email", "sandbox@test"]);
  await execFileP("git", ["-C", sandboxWorktree, "config", "user.name", "sandbox"]);
  await execFileP("git", ["-C", sandboxWorktree, "config", "commit.gpgsign", "false"]);
  await execFileP("git", ["-C", sandboxWorktree, "remote", "add", "origin", daytonaRemoteBare]);

  return {
    skillsBare,
    daytonaRemoteBare,
    sandboxWorktree,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function pushFeatureBranchToRemote(opts: {
  worktree: string;
  branch: string;
  manifest: string;
  body: string;
}): Promise<string> {
  await writeFile(join(opts.worktree, "SKILL.md"), opts.manifest);
  await writeFile(join(opts.worktree, "skill.py"), opts.body);
  await execFileP("git", ["-C", opts.worktree, "add", "."]);
  await execFileP("git", ["-C", opts.worktree, "commit", "-m", `add ${opts.branch}`]);
  const sha = (await execFileP("git", ["-C", opts.worktree, "rev-parse", "HEAD"])).stdout.trim();
  await execFileP("git", [
    "-C",
    opts.worktree,
    "push",
    "-f",
    "origin",
    `HEAD:refs/heads/${opts.branch}`,
  ]);
  return sha;
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  try {
    await execFileP("git", ["-C", repo, "rev-parse", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

async function readHead(repo: string): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", repo, "symbolic-ref", "HEAD"]);
  return stdout.trim();
}

describe("skill authoring bootstrap — boot → fetch → register chain", () => {
  let repos: Repos;

  beforeEach(async () => {
    repos = await setupRepos();
  });

  afterEach(async () => {
    await repos.cleanup();
  });

  it("boot wires both halves; sandbox push + fetchFeatureBranch + register advances main", async () => {
    // ─── Boot ───────────────────────────────────────────────────────
    // `bootstrapSkillsRepo` already ran in setupRepos. Run the DB half
    // here so the test exercises the production ordering. The bare
    // repo's HEAD assertion is the regression check for the
    // master-default-branch bug — without the symbolic-ref pin, HEAD
    // would still point at master on hosts whose `init.defaultBranch`
    // hasn't been set to main.
    expect(await readHead(repos.skillsBare)).toBe("refs/heads/main");

    const ensureResult = await ensureSkillsCodingRepo(
      { runInTx: tx, codingStore },
      { skillsRepoPath: repos.skillsBare },
    );
    expect(ensureResult.kind).toBe("created");
    if (ensureResult.kind === "created") {
      expect(ensureResult.name).toBe(SKILLS_CODING_REPO_NAME);
      expect(ensureResult.localPath).toBe(repos.skillsBare);
      expect(ensureResult.remoteUrl).toBe(repos.daytonaRemoteBare);
    }

    const row = await tx((trx) => codingStore.getRepoByName(trx, SKILLS_CODING_REPO_NAME));
    expect(row).toBeDefined();
    expect(row?.localPath).toBe(repos.skillsBare);
    expect(row?.defaultBranch).toBe("main");
    expect(row?.allowedBackends).toEqual(["claude"]);
    expect(row?.maxConcurrentTasks).toBe(1);

    // ─── Sandbox push ───────────────────────────────────────────────
    // Simulate what Daytona does on a successful coding task: commit
    // SKILL.md + skill.py on a feature branch, push to origin.
    const branch = "skill/hn-digest";
    const sha = await pushFeatureBranchToRemote({
      worktree: repos.sandboxWorktree,
      branch,
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });

    // Pre-fetch: the feature branch exists on the remote but NOT in the
    // bare skill library. This is the gap the bug used to leave open.
    expect(await refExists(repos.daytonaRemoteBare, `refs/heads/${branch}`)).toBe(true);
    expect(await refExists(repos.skillsBare, `refs/heads/${branch}`)).toBe(false);

    // ─── Host-side fetch into the bare repo ─────────────────────────
    // Pre-fix, this would land the branch at `refs/remotes/origin/<branch>`
    // and `register` below would fail with "branch_not_found". Post-fix,
    // the bare-repo detection routes it to `refs/heads/<branch>`.
    await fetchFeatureBranch({
      localRepoPath: repos.skillsBare,
      remoteUrl: repos.daytonaRemoteBare,
      branch,
      identity: fakeIdentity,
    });

    expect(await refExists(repos.skillsBare, `refs/heads/${branch}`)).toBe(true);
    // Defense in depth: the wrong refspec must NOT also be populated —
    // a regression that double-writes would still pass the above check.
    expect(await refExists(repos.skillsBare, `refs/remotes/origin/${branch}`)).toBe(false);

    // ─── Register ───────────────────────────────────────────────────
    // The fetched branch is now visible to the skill runner. `register`
    // reads SKILL.md + skill.py at the branch tip and advances main.
    const runner = await SkillRunnerImpl.create({
      store: skillStore,
      runInTx: tx,
      memory: makeMockMemory(),
      secretsStore: mock<SecretsStore>(),
      files: {
        read: vi.fn().mockResolvedValue(""),
        write: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      },
      user: { id: "user-1", timezone: "UTC" },
      memoryBankId: "bank-1",
      skillsRepoPath: repos.skillsBare,
    });

    const registerResult = await runner.register({ branch });
    expect(registerResult.status).toBe("live");
    expect(registerResult.name).toBe("hn_digest");
    expect(registerResult.gitSha).toBe(sha);

    // main now points at the feature-branch tip.
    const mainSha = (
      await execFileP("git", ["-C", repos.skillsBare, "rev-parse", "refs/heads/main"])
    ).stdout.trim();
    expect(mainSha).toBe(sha);

    // DB row reflects the registered skill.
    const skill = await tx((trx) => skillStore.getSkillByName(trx, "hn_digest"));
    expect(skill?.gitSha).toBe(sha);
    expect(skill?.disabled).toBe(false);
  }, 30_000);

  it("ensureSkillsCodingRepo is idempotent across re-boots", async () => {
    // Simulates two boots of the cogmo daemon against the same DB. The
    // second call must not throw a UNIQUE-violation on `coding_repos.name`
    // and, when the bare repo's origin hasn't changed, must report
    // `unchanged` without updating the row.
    const first = await ensureSkillsCodingRepo(
      { runInTx: tx, codingStore },
      { skillsRepoPath: repos.skillsBare },
    );
    expect(first.kind).toBe("created");

    const second = await ensureSkillsCodingRepo(
      { runInTx: tx, codingStore },
      { skillsRepoPath: repos.skillsBare },
    );
    expect(second.kind).toBe("unchanged");
    if (second.kind === "unchanged") {
      expect(second.localPath).toBe(repos.skillsBare);
      expect(second.remoteUrl).toBe(repos.daytonaRemoteBare);
    }
  });
});

function makeMockMemory(): MemoryProvider {
  const memory = mock<MemoryProvider>();
  memory.recall.mockResolvedValue({ memories: [] });
  return memory;
}
