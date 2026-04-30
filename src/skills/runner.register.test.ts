import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { bootstrapSkillsRepo } from "./repo.js";
import { SkillRunnerImpl } from "./runner.js";
import { DrizzleSkillStore } from "./store/index.js";

const execFileP = promisify(execFile);

let db: Database;
let close: () => Promise<void>;
let store: DrizzleSkillStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  store = new DrizzleSkillStore(db);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

function makeMockMemory(): MemoryProvider {
  return {
    name: "mock",
    retain: vi.fn().mockResolvedValue(undefined),
    retainBatch: vi.fn().mockResolvedValue(undefined),
    recall: vi.fn().mockResolvedValue({ memories: [] }),
    reflect: vi.fn(),
  };
}

function makeMockSecrets(): SecretsStore {
  return {
    getSecret: vi.fn(),
    getSecretById: vi.fn(),
    getSecretMeta: vi.fn(),
    listSecretNames: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal SecretsStore stub
  } as any;
}

const ECHO_MANIFEST = `---
name: echo
description: a tier-1 skill that echoes one int field
tier: wasm
inputs:
  type: object
  properties:
    x:
      type: integer
  required:
    - x
outputs:
  type: object
  properties:
    echo:
      type: integer
  required:
    - echo
---

# Echo
`;

const ECHO_BODY = `
async def run(inputs, ctx):
    return {"echo": inputs["x"] + 1}
`;

const ECHO_BODY_BAD_OUTPUT = `
async def run(inputs, ctx):
    return {"wrong_field": "not an integer"}
`;

interface RepoSetup {
  bare: string;
  work: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a real bare repo (with the production pre-receive hook) plus a
 * working clone the test can push feature branches from. Mirrors what the
 * agent's worktree would look like in production.
 */
async function setupRepo(): Promise<RepoSetup> {
  const root = await mkdtemp(join(tmpdir(), "skills-register-"));
  const bare = join(root, "skills.git");
  const work = join(root, "work");
  await bootstrapSkillsRepo({ path: bare });
  await mkdir(work);
  await execFileP("git", ["init", "-b", "main", work]);
  await execFileP("git", ["-C", work, "config", "user.email", "test@cogmo.dev"]);
  await execFileP("git", ["-C", work, "config", "user.name", "test"]);
  await execFileP("git", ["-C", work, "config", "commit.gpgsign", "false"]);
  await execFileP("git", ["-C", work, "remote", "add", "origin", bare]);

  return {
    bare,
    work,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Push a SKILL.md + skill.py pair to a feature branch on the bare repo. Returns
 * the branch tip SHA so tests can assert against it.
 */
async function pushFeatureBranch(opts: {
  work: string;
  branch: string;
  manifest: string;
  body: string;
}): Promise<string> {
  await writeFile(join(opts.work, "SKILL.md"), opts.manifest);
  await writeFile(join(opts.work, "skill.py"), opts.body);
  await execFileP("git", ["-C", opts.work, "add", "."]);
  await execFileP("git", [
    "-C",
    opts.work,
    "commit",
    "-m",
    `update ${opts.branch}`,
    "--allow-empty",
  ]);
  const sha = (await execFileP("git", ["-C", opts.work, "rev-parse", "HEAD"])).stdout.trim();
  await execFileP("git", [
    "-C",
    opts.work,
    "push",
    "-f",
    "origin",
    `HEAD:refs/heads/${opts.branch}`,
  ]);
  return sha;
}

async function getMainSha(bare: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", bare, "rev-parse", "refs/heads/main"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

describe("SkillRunnerImpl.register (P3.3)", { timeout: 60_000 }, () => {
  let repo: RepoSetup;

  beforeEach(async () => {
    repo = await setupRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function makeRunner() {
    return SkillRunnerImpl.create({
      store,
      memory: makeMockMemory(),
      secretsStore: makeMockSecrets(),
      user: { id: "user-1", timezone: "UTC" },
      memoryBankId: "bank-1",
      skillsRepoPath: repo.bare,
    });
  }

  it("registers a fresh skill — advances main, writes DB rows, deletes branch", async () => {
    const runner = await makeRunner();
    const sha = await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });

    const result = await runner.register({ branch: "skill/echo" });
    expect(result.status).toBe("live");
    expect(result.name).toBe("echo");
    expect(result.gitSha).toBe(sha);
    expect(result.riskTier).toBe("notify");

    // main now points at the branch tip.
    expect(await getMainSha(repo.bare)).toBe(sha);

    // skills row exists with correct sha + tier.
    const skill = await store.getSkillByName("echo");
    expect(skill?.gitSha).toBe(sha);
    expect(skill?.tier).toBe("wasm");
    expect(skill?.disabled).toBe(false);

    // Feature branch deleted.
    await expect(
      execFileP("git", ["-C", repo.bare, "rev-parse", "refs/heads/skill/echo"]),
    ).rejects.toThrow();
  });

  it("re-register with same branch tip is a no-op (idempotent)", async () => {
    const runner = await makeRunner();
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    const first = await runner.register({ branch: "skill/echo" });
    expect(first.status).toBe("live");

    // Push the same content under a fresh branch (same tree, new commit since
    // the old branch was deleted by the first register).
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo-2",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });

    // The new branch has a *different* sha from main — register treats it
    // as an update, not a no-op. So we exercise no-op by re-registering main
    // itself: bring up another branch pointing at main's sha exactly.
    const mainSha = await getMainSha(repo.bare);
    expect(mainSha).toBeTruthy();
    await execFileP("git", ["-C", repo.work, "fetch", "origin", `${mainSha}:refs/heads/at-main`]);
    await execFileP("git", [
      "-C",
      repo.work,
      "push",
      "origin",
      `refs/heads/at-main:refs/heads/at-main`,
    ]);
    const second = await runner.register({ branch: "at-main" });
    expect(second.status).toBe("no_op");
  });

  it("rejects a non-fast-forward branch", async () => {
    const runner = await makeRunner();
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    await runner.register({ branch: "skill/echo" });

    // Build a divergent branch: reset work to a fresh root commit (no
    // ancestor of main), push as `divergent`.
    await execFileP("git", ["-C", repo.work, "checkout", "--orphan", "fresh"]);
    await writeFile(join(repo.work, "SKILL.md"), ECHO_MANIFEST.replace("name: echo", "name: alt"));
    await writeFile(join(repo.work, "skill.py"), ECHO_BODY);
    await execFileP("git", ["-C", repo.work, "add", "."]);
    await execFileP("git", ["-C", repo.work, "commit", "-m", "fresh root"]);
    await execFileP("git", ["-C", repo.work, "push", "origin", "fresh:refs/heads/divergent"]);

    const result = await runner.register({ branch: "divergent" });
    expect(result.status).toBe("rejected");
    expect(result.errors?.[0]).toMatch(/non_fast_forward/);
  });

  it("rejects a missing branch", async () => {
    const runner = await makeRunner();
    const result = await runner.register({ branch: "nope" });
    expect(result.status).toBe("rejected");
    expect(result.errors?.[0]).toMatch(/branch_not_found/);
  });

  it("rejects a branch missing SKILL.md", async () => {
    const runner = await makeRunner();
    await writeFile(join(repo.work, "skill.py"), ECHO_BODY);
    await execFileP("git", ["-C", repo.work, "add", "."]);
    await execFileP("git", ["-C", repo.work, "commit", "-m", "no manifest"]);
    await execFileP("git", ["-C", repo.work, "push", "origin", "main:refs/heads/no-manifest"]);
    const result = await runner.register({ branch: "no-manifest" });
    expect(result.status).toBe("rejected");
    expect(result.errors?.[0]).toMatch(/missing_skill_md/);
  });

  it("rejects a branch with invalid manifest", async () => {
    const runner = await makeRunner();
    const badManifest = `---
name: bad
description: short
tier: wasm
---
`;
    await pushFeatureBranch({
      work: repo.work,
      branch: "bad",
      manifest: badManifest,
      body: ECHO_BODY,
    });
    const result = await runner.register({ branch: "bad" });
    expect(result.status).toBe("rejected");
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("invokes the skill end-to-end after register (source loaded from git)", async () => {
    const runner = await makeRunner();
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    await runner.register({ branch: "skill/echo" });

    const result = await runner.invoke({ name: "echo", inputs: { x: 7 } });
    expect(result.status).toBe("success");
    expect(result.output).toEqual({ echo: 8 });
  });

  it("a fresh runner reads source from git (cross-process/cross-instance)", async () => {
    // Register in one runner, invoke in a brand new runner — proves the
    // source lookup goes to git, not just the in-memory cache. Mirrors what
    // the CLI subprocess + the per-turn orchestrator do.
    const r1 = await makeRunner();
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    await r1.register({ branch: "skill/echo" });

    const r2 = await makeRunner();
    const result = await r2.invoke({ name: "echo", inputs: { x: 7 } });
    expect(result.status).toBe("success");
    expect(result.output).toEqual({ echo: 8 });
  });

  it("validates outputs against manifest.outputs and surfaces the failure", async () => {
    const runner = await makeRunner();
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/bad-out",
      manifest: ECHO_MANIFEST.replace("name: echo", "name: bad-out"),
      body: ECHO_BODY_BAD_OUTPUT,
    });
    await runner.register({ branch: "skill/bad-out" });
    const result = await runner.invoke({ name: "bad-out", inputs: { x: 1 } });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/output failed schema/);
  });

  it("listToolDefs returns description + inputs for the LLM tool registrar", async () => {
    const runner = await makeRunner();
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    await runner.register({ branch: "skill/echo" });

    const defs = await runner.listToolDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("echo");
    expect(defs[0]?.description).toContain("echoes one int field");
    expect(defs[0]?.inputs).toMatchObject({ type: "object" });
  });

  it("re-register replaces the live source — listToolDefs sees the new manifest", async () => {
    const runner = await makeRunner();
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    await runner.register({ branch: "skill/echo" });

    const updatedManifest = ECHO_MANIFEST.replace(
      "a tier-1 skill that echoes one int field",
      "v2 now adds two instead",
    );
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo-v2",
      manifest: updatedManifest,
      body: ECHO_BODY,
    });
    const second = await runner.register({ branch: "skill/echo-v2" });
    expect(second.status).toBe("live");

    const defs = await runner.listToolDefs();
    expect(defs[0]?.description).toContain("v2 now adds two instead");
  });

  describe("rollback", () => {
    it("rewinds main + skills.git_sha to a prior commit", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v1",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v1" });

      const updatedManifest = ECHO_MANIFEST.replace(
        "a tier-1 skill that echoes one int field",
        "v2 description",
      );
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v2",
        manifest: updatedManifest,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v2" });

      const result = await runner.rollback({ name: "echo", toGitSha: v1 });
      expect(result.status).toBe("live");
      expect(result.gitSha).toBe(v1);

      expect(await getMainSha(repo.bare)).toBe(v1);
      const skill = await store.getSkillByName("echo");
      expect(skill?.gitSha).toBe(v1);
    });

    it("rollback to current sha is a no-op", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo" });

      const result = await runner.rollback({ name: "echo", toGitSha: v1 });
      expect(result.status).toBe("no_op");
    });
  });

  describe("deny", () => {
    it("denies a deploy by id (idempotent on missing/already-resolved id)", async () => {
      const runner = await makeRunner();
      // No real pending deploy exists — denyDeploy is idempotent.
      await expect(
        runner.denyDeploy({ pendingId: "00000000-0000-0000-0000-000000000000" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("deregister", () => {
    it("soft-disables the skill; list excludes it", async () => {
      const runner = await makeRunner();
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo" });

      await runner.deregister({ name: "echo" });
      const list = await runner.list();
      expect(list).toHaveLength(0);
      // Row still exists for audit history.
      const skill = await store.getSkillByName("echo");
      expect(skill?.disabled).toBe(true);
    });

    it("rejects deregister of unknown skill", async () => {
      const runner = await makeRunner();
      await expect(runner.deregister({ name: "missing" })).rejects.toThrow(/not found/);
    });
  });
});
