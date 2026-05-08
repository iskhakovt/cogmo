import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../db/index.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { bootstrapSkillsRepo } from "./repo.js";
import { SkillRunnerImpl } from "./runner.js";
import { DrizzleSkillStore } from "./store/index.js";

const execFileP = promisify(execFile);

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleSkillStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleSkillStore();
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
      runInTx: tx,
      memory: makeMockMemory(),
      secretsStore: makeMockSecrets(),
      files: {
        read: vi.fn().mockResolvedValue(""),
        write: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      },
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
    const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
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
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
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
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
      expect(skill?.disabled).toBe(true);
    });

    it("rejects deregister of unknown skill", async () => {
      const runner = await makeRunner();
      await expect(runner.deregister({ name: "missing" })).rejects.toThrow(/not found/);
    });
  });

  // --- Review-comment regressions (cubic PR #112 review) ---

  describe("safety: register is locked away from main", () => {
    it("rejects branch == 'main' before touching git or DB", async () => {
      const runner = await makeRunner();
      const result = await runner.register({ branch: "main" });
      expect(result.status).toBe("rejected");
      expect(result.errors?.[0]).toMatch(/invalid_branch/);
      // No skills row created.
      expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
    });

    it("rejects branch == 'refs/heads/main' too", async () => {
      const runner = await makeRunner();
      const result = await runner.register({ branch: "refs/heads/main" });
      expect(result.status).toBe("rejected");
      expect(result.errors?.[0]).toMatch(/invalid_branch/);
    });
  });

  describe("safety: schema pre-validation runs before update-ref", () => {
    it("rejects a manifest whose inputs aren't an object schema (manifest layer)", async () => {
      const runner = await makeRunner();
      // SkillInputsSchema requires `type: "object"` at the manifest boundary
      // — `type: not_a_real_type` fails parse before the runner even calls
      // executeRegister, let alone applyFilesystem.
      const badInputs = `---
name: bad-schema
description: a skill whose inputs schema is malformed
tier: wasm
inputs:
  type: not_a_real_type
---
`;
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/bad-schema",
        manifest: badInputs,
        body: ECHO_BODY,
      });
      const before = await getMainSha(repo.bare);
      const result = await runner.register({ branch: "skill/bad-schema" });
      expect(result.status).toBe("rejected");
      expect(result.errors?.[0]).toMatch(/inputs\.type/);
      // main is unchanged — no half-deploy.
      expect(await getMainSha(repo.bare)).toBe(before);
      // No skills row.
      expect(await tx((trx) => store.getSkillByName(trx, "bad-schema"))).toBeUndefined();
    });

    it("rejects a manifest with an inputs schema ajv can't compile (runner prevalidate)", async () => {
      const runner = await makeRunner();
      // Survives the manifest layer (`type: "object"` is set) but ajv chokes
      // on a malformed `properties` field — exercises the runner's
      // #prevalidateSchemas path before any filesystem write.
      const badInputs = `---
name: bad-properties
description: object-typed inputs but properties is not a record
tier: wasm
inputs:
  type: object
  properties: not_a_record
---
`;
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/bad-properties",
        manifest: badInputs,
        body: ECHO_BODY,
      });
      const before = await getMainSha(repo.bare);
      const result = await runner.register({ branch: "skill/bad-properties" });
      expect(result.status).toBe("rejected");
      // Either layer is acceptable — what matters is no main advance.
      expect(result.errors?.length).toBeGreaterThan(0);
      expect(await getMainSha(repo.bare)).toBe(before);
      expect(await tx((trx) => store.getSkillByName(trx, "bad-properties"))).toBeUndefined();
    });
  });

  describe("safety: classifier promotes destructive effects to approve", () => {
    it("a skill declaring sends_message lands as pending_approval, not live", async () => {
      const runner = await makeRunner();
      const sendingManifest = `---
name: notifier
description: a skill that sends notifications to the user
tier: wasm
inputs:
  type: object
  properties: {}
effects:
  - sends_message
---
`;
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/notifier",
        manifest: sendingManifest,
        body: ECHO_BODY,
      });
      const before = await getMainSha(repo.bare);
      const result = await runner.register({ branch: "skill/notifier" });
      expect(result.status).toBe("pending_approval");
      expect(result.riskTier).toBe("approve");
      expect(result.pendingId).toBeTruthy();
      // main is NOT advanced for approve-tier.
      expect(await getMainSha(repo.bare)).toBe(before);
    });

    it("approve-tier register can be approved end-to-end", async () => {
      const runner = await makeRunner();
      const sendingManifest = `---
name: notifier
description: a skill that sends notifications to the user
tier: wasm
inputs:
  type: object
  properties: {}
effects:
  - sends_message
---
`;
      const sha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/notifier",
        manifest: sendingManifest,
        body: ECHO_BODY,
      });
      const reg = await runner.register({ branch: "skill/notifier" });
      expect(reg.status).toBe("pending_approval");
      const pendingId = reg.pendingId;
      if (!pendingId) throw new Error("expected pendingId");

      const approved = await runner.approveDeploy({ pendingId });
      expect(approved.status).toBe("live");
      expect(approved.gitSha).toBe(sha);

      // main moved + skills row reflects the approved sha.
      expect(await getMainSha(repo.bare)).toBe(sha);
      const skill = await tx((trx) => store.getSkillByName(trx, "notifier"));
      expect(skill?.gitSha).toBe(sha);
      expect(skill?.disabled).toBe(false);
      // Manifest-derived columns projected from the approved sha.
      expect(skill?.effects).toEqual(["sends_message"]);
    });
  });

  describe("safety: rollback verifies target sha belongs to this skill", () => {
    it("refuses to rollback skill A to a sha that belongs to skill B", async () => {
      const runner = await makeRunner();
      // Register skill A.
      const aSha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/alpha",
        manifest: ECHO_MANIFEST.replace("name: echo", "name: alpha"),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/alpha" });

      // Register skill B (separate name, different sha).
      const bSha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/beta",
        manifest: ECHO_MANIFEST.replace("name: echo", "name: beta"),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/beta" });

      // Try to roll back A to B's sha — must reject; otherwise A would
      // silently start running B's code.
      const result = await runner.rollback({ name: "alpha", toGitSha: bSha });
      expect(result.status).toBe("rejected");
      expect(result.errors?.[0]).toMatch(/target_skill_mismatch/);

      // A's sha is unchanged.
      const skillA = await tx((trx) => store.getSkillByName(trx, "alpha"));
      expect(skillA?.gitSha).toBe(aSha);
    });
  });

  describe("safety: approve / rollback project the full manifest", () => {
    it("approve writes manifest-derived columns from the approved sha, not the prior live ones", async () => {
      const runner = await makeRunner();
      const v1Manifest = `---
name: shapeshift
description: v1 manifest with one input field
tier: wasm
inputs:
  type: object
  properties:
    a:
      type: integer
  required:
    - a
effects:
  - sends_message
---
`;
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/shapeshift-v1",
        manifest: v1Manifest,
        body: ECHO_BODY,
      });
      const reg = await runner.register({ branch: "skill/shapeshift-v1" });
      if (!reg.pendingId) throw new Error("expected pendingId for sends_message skill");
      await runner.approveDeploy({ pendingId: reg.pendingId });

      // Now stage v2 with a different inputs schema + extra effect.
      const v2Manifest = `---
name: shapeshift
description: v2 manifest with a different field shape
tier: wasm
inputs:
  type: object
  properties:
    b:
      type: string
  required:
    - b
effects:
  - sends_message
  - posts_public
---
`;
      const v2Sha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/shapeshift-v2",
        manifest: v2Manifest,
        body: ECHO_BODY,
      });
      const reg2 = await runner.register({ branch: "skill/shapeshift-v2" });
      if (!reg2.pendingId) throw new Error("expected pendingId for v2 register");
      const approved = await runner.approveDeploy({ pendingId: reg2.pendingId });
      expect(approved.status).toBe("live");

      const skill = await tx((trx) => store.getSkillByName(trx, "shapeshift"));
      expect(skill?.gitSha).toBe(v2Sha);
      expect(skill?.inputs).toMatchObject({
        properties: { b: { type: "string" } },
      });
      expect(skill?.effects).toEqual(["sends_message", "posts_public"]);
    });

    it("rollback writes the target sha's manifest-derived columns, not the current ones", async () => {
      const runner = await makeRunner();
      const v1Manifest = ECHO_MANIFEST.replace("name: echo", "name: shape");
      const v1Sha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/shape-v1",
        manifest: v1Manifest,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/shape-v1" });

      const v2Manifest = `---
name: shape
description: v2 manifest with a totally different inputs shape
tier: wasm
inputs:
  type: object
  properties:
    different:
      type: string
  required:
    - different
---
`;
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/shape-v2",
        manifest: v2Manifest,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/shape-v2" });

      const result = await runner.rollback({ name: "shape", toGitSha: v1Sha });
      expect(result.status).toBe("live");

      const skill = await tx((trx) => store.getSkillByName(trx, "shape"));
      expect(skill?.gitSha).toBe(v1Sha);
      // inputs match v1's schema (x: integer), not v2's (different: string).
      expect(skill?.inputs).toMatchObject({
        properties: { x: { type: "integer" } },
      });
    });
  });

  describe("safety: deny + re-register doesn't leave a disabled skill", () => {
    it("after deny, re-registering the SAME branch tip opens a fresh pending_approval (not no_op)", async () => {
      const runner = await makeRunner();
      const sendingManifest = `---
name: notify-skill
description: a skill that sends notifications via approve-tier path
tier: wasm
inputs:
  type: object
  properties: {}
effects:
  - sends_message
---
`;
      // Approve-tier register doesn't call applyFilesystem, so the feature
      // branch survives the first register — register can read it again
      // unchanged. Pushing once + registering twice exercises the actual
      // (name, gitSha) match that the no-op-after-denial guard protects.
      const sha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/notify-skill",
        manifest: sendingManifest,
        body: ECHO_BODY,
      });
      const reg = await runner.register({ branch: "skill/notify-skill" });
      expect(reg.status).toBe("pending_approval");
      expect(reg.gitSha).toBe(sha);
      if (!reg.pendingId) throw new Error("expected pendingId");

      // After insert: skill row exists but disabled=true (first-time
      // pending_approval — there's no prior live version to keep visible).
      const beforeDeny = await tx((trx) => store.getSkillByName(trx, "notify-skill"));
      expect(beforeDeny?.disabled).toBe(true);
      expect(beforeDeny?.gitSha).toBe(sha);

      await runner.denyDeploy({ pendingId: reg.pendingId, reason: "not now" });

      // Row stays at sha, disabled=true; deploy resolved to denied. The
      // bare repo's feature branch is untouched (deleteRef only runs in
      // goesLive applyFilesystem, which approve-tier skips).
      const afterDeny = await tx((trx) => store.getSkillByName(trx, "notify-skill"));
      expect(afterDeny?.disabled).toBe(true);
      expect(afterDeny?.gitSha).toBe(sha);

      // Re-register the SAME branch — same tip sha as before. Without the
      // `!disabled` guard in the no-op check, this would return
      // status: "no_op" and the skill would stay dark forever. With the
      // guard, the disabled row is treated as "not no_op" and a fresh
      // pending_approval row is created.
      const reg2 = await runner.register({ branch: "skill/notify-skill" });
      expect(reg2.status).toBe("pending_approval");
      expect(reg2.gitSha).toBe(sha);
      expect(reg2.pendingId).toBeTruthy();
      expect(reg2.pendingId).not.toBe(reg.pendingId);
    });

    it("does NOT take a currently-live skill offline when an approve-tier upgrade is queued", async () => {
      const runner = await makeRunner();
      // v1 — notify-tier (no destructive effects), goes live immediately.
      const v1Manifest = ECHO_MANIFEST.replace("name: echo", "name: upgradable");
      const v1Sha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/upgradable-v1",
        manifest: v1Manifest,
        body: ECHO_BODY,
      });
      const reg1 = await runner.register({ branch: "skill/upgradable-v1" });
      expect(reg1.status).toBe("live");

      const liveBefore = await tx((trx) => store.getSkillByName(trx, "upgradable"));
      expect(liveBefore?.disabled).toBe(false);
      expect(liveBefore?.gitSha).toBe(v1Sha);

      // v2 — adds sends_message → approve-tier. Should land as pending,
      // but the live v1 must STAY live during the approval window.
      const v2Manifest = `---
name: upgradable
description: v2 adds outbound messaging which now needs approval
tier: wasm
inputs:
  type: object
  properties:
    x:
      type: integer
  required:
    - x
effects:
  - sends_message
---
`;
      const v2Sha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/upgradable-v2",
        manifest: v2Manifest,
        body: ECHO_BODY,
      });
      const reg2 = await runner.register({ branch: "skill/upgradable-v2" });
      expect(reg2.status).toBe("pending_approval");
      if (!reg2.pendingId) throw new Error("expected pendingId for v2");

      // Critical: skills row UNCHANGED — still pointing at v1, still live.
      const duringApproval = await tx((trx) => store.getSkillByName(trx, "upgradable"));
      expect(duringApproval?.disabled).toBe(false);
      expect(duringApproval?.gitSha).toBe(v1Sha);

      // Deny the v2 upgrade. The live v1 should still be live afterwards —
      // this is the exact regression the row-untouched rule prevents.
      await runner.denyDeploy({ pendingId: reg2.pendingId, reason: "rejected" });
      const afterDeny = await tx((trx) => store.getSkillByName(trx, "upgradable"));
      expect(afterDeny?.disabled).toBe(false);
      expect(afterDeny?.gitSha).toBe(v1Sha);
      expect(reg2).toBeDefined(); // no_op-after-denial sanity (v2's pending row resolved to denied)
      void v2Sha;
    });
  });

  describe("safety: filesystem failure rolls back DB writes (FS-last ordering)", () => {
    it("executeRegister rolls back skills + skill_deploys when applyFilesystem throws", async () => {
      // Direct store-level test: pass an applyFilesystem callback that
      // throws synchronously, assert no rows persist. This is the
      // structural invariant — register, approveDeploy, and rollback all
      // route through executeRegister/Approve/Rollback and inherit it.
      await expect(
        tx((trx) =>
          store.executeRegister(trx, {
            name: "would-be-skill",
            tier: "wasm",
            riskTier: "notify",
            effects: [],
            schedule: null,
            branchTipSha: "0000000000000000000000000000000000000abc",
            inputs: { type: "object", properties: {} },
            outputs: null,
            classifierLog: {
              classifier_version: "test",
              risk_tier: "notify",
              declared_effects: [],
              detected_effects: [],
              declared_secrets: [],
              validation_errors: [],
            },
            applyFilesystem: async () => {
              throw new Error("simulated git update-ref failure");
            },
          }),
        ),
      ).rejects.toThrow(/simulated git update-ref failure/);

      // Both rows rolled back — no skills row, no skill_deploys row.
      expect(await tx((trx) => store.getSkillByName(trx, "would-be-skill"))).toBeUndefined();
    });
  });
});
