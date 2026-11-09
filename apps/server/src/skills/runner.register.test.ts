import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { err, ok } from "neverthrow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { profiles, users } from "../agent/store/schema.js";
import type { Database, Transactor } from "../db/index.js";
import type { SandboxClient } from "../sandbox/index.js";
import { GitHubIdentitySchema } from "../secrets/github.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { assertStatus, expectDefined } from "../test/assertions.js";
import { mockFilesService } from "../test/factories.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { makePopulatedBareRepo } from "../test/skills-bare-repo.js";
import { offlineWasm } from "../test/skills-fixtures.js";
import { channels, userIdentities } from "../transport/store/schema.js";
import { hashLockfileContents } from "./deps.js";
import { migrateSkillsLayout } from "./migrate-layout.js";
import { loadBundledPackages } from "./pyodide-compat.js";
import { bootstrapSkillsRepo } from "./repo.js";
import type { SkillRunAs, SkillRunServices } from "./run-as.js";
import { type SkillActor, type SkillDeployOrigin, SkillRunnerImpl } from "./runner.js";
import type { SchemaImportError } from "./schema-import.js";
import { DrizzleSkillStore, type SkillRunIdentity, type SkillStore } from "./store/index.js";
import type { SkillInputs } from "./types.js";
import type { ContainerSchemaImporter } from "./worker-sysbox/schema-import.js";
import type { WasmPackagesError, WasmSchemaImporter } from "./worker-wasm/wasm.js";

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

/** Owner + default profile; only a scheduled skill writes them to a row. */
const DEFAULT_RUN_AS = {
  userId: "019d0000-0000-7000-8000-0000000000a1",
  profileId: "019d0000-0000-7000-8000-0000000000b1",
};

/** The CLI's origin: the install owner with the default profile. */
const OWNER: SkillDeployOrigin = { kind: "owner" };

/** A run-as over real user and profile rows, which a run row references. */
async function seededRunAs(): Promise<SkillRunAs> {
  const [user] = await db.insert(users).values({}).returning({ id: users.id });
  const [profile] = await db
    .insert(profiles)
    .values({ userId: null, name: "run-as", basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  return {
    userId: expectDefined(user, "user").id,
    profileId: expectDefined(profile, "profile").id,
    service: { memory: mock<SkillRunServices["memory"]>(), files: mockFilesService() },
  };
}

function makeMockSecrets(): SecretsStore {
  return mock<SecretsStore>();
}

const ECHO_MANIFEST = `---
name: echo
description: a wasm skill that echoes one int field
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

const ECHO_WITH_DEPS = `---
name: echo
description: a wasm skill that echoes one int field
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
dependencies:
  - httpx==0.27.0
---

# Echo
`;

const ECHO_BODY_BAD_OUTPUT = `
async def run(inputs, ctx):
    return {"wrong_field": "not an integer"}
`;

interface RepoSetup {
  bare: string;
  work: string;
  /** Boot's layout commit, main before any deploy. */
  layout: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a real bare repo (with the production pre-receive hook) plus a
 * working clone the test can push feature branches from. Mirrors what the
 * agent's worktree would look like in production.
 */
async function setupRepo(
  opts: { beforeLayout?: (bare: string) => Promise<void> } = {},
): Promise<RepoSetup> {
  const root = await mkdtemp(join(tmpdir(), "skills-register-"));
  const bare = join(root, "skills.git");
  const work = join(root, "work");
  await bootstrapSkillsRepo({ path: bare });
  await opts.beforeLayout?.(bare);
  await mkdir(work);
  await execFileP("git", ["init", "-b", "main", work]);
  await execFileP("git", ["-C", work, "config", "user.email", "test@cogmo.dev"]);
  await execFileP("git", ["-C", work, "config", "user.name", "test"]);
  await execFileP("git", ["-C", work, "config", "commit.gpgsign", "false"]);
  await execFileP("git", ["-C", work, "remote", "add", "origin", bare]);
  // Boot's layout commit, which every branch descends from. A test that
  // makes a second repo records that repo's in place of the first.
  await db.execute(sql`DELETE FROM skills_repo_layout`);
  const layout = await migrateSkillsLayout({ runInTx: tx, store }, bare);
  await execFileP("git", ["-C", work, "fetch", "-q", "origin", "main"]);
  await execFileP("git", ["-C", work, "reset", "-q", "--hard", "FETCH_HEAD"]);

  return {
    bare,
    work,
    layout,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** A skill file's path in the working clone, `skills/<name>/<file>`, its directory made. */
function skillFile(work: string, file: string, name: string): string {
  mkdirSync(join(work, "skills", name), { recursive: true });
  return join(work, "skills", name, file);
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
  const name = expectDefined(/^name:\s*(\S+)/m.exec(opts.manifest)?.[1], "manifest name");
  await writeFile(skillFile(opts.work, "SKILL.md", name), opts.manifest);
  await writeFile(skillFile(opts.work, "skill.py", name), opts.body);
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

/**
 * Rewind main to `sha` and drop every commit only the old main held, as
 * restoring the repo from a remote that lagged a deploy leaves it.
 */
async function restoreMainTo(repo: RepoSetup, sha: string, dropped: string): Promise<void> {
  await git(repo.bare, "update-ref", "refs/heads/main", sha);
  await git(repo.bare, "reflog", "expire", "--expire=now", "--all");
  await git(repo.bare, "gc", "-q", "--prune=now");
  await expect(git(repo.bare, "cat-file", "-e", `${dropped}^{commit}`)).rejects.toThrow();
}

/** Point the working clone at the bare repo's main, as a fresh branch would start. */
async function resetToMain(repo: RepoSetup): Promise<void> {
  await execFileP("git", ["-C", repo.work, "fetch", "-q", "origin", "main"]);
  await execFileP("git", ["-C", repo.work, "reset", "-q", "--hard", "FETCH_HEAD"]);
}

async function git(repoPath: string, ...args: string[]): Promise<string> {
  return (await execFileP("git", ["-C", repoPath, ...args])).stdout.trim();
}

async function isAncestorIn(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await execFileP("git", ["-C", repoPath, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
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

  async function makeRunner(overrides: Partial<Parameters<typeof SkillRunnerImpl.create>[0]> = {}) {
    return SkillRunnerImpl.create({
      store,
      runInTx: tx,
      secretsStore: makeMockSecrets(),
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      skillsRepoPath: repo.bare,
      // The fixtures' lockfiles carry placeholder hashes, so register must
      // neither fetch wheels nor spawn a probe child.
      ...offlineWasm(repo.bare),
      ...overrides,
    });
  }

  async function makeRunnerFor(skillsRepoPath: string) {
    return makeRunner({ skillsRepoPath, ...offlineWasm(skillsRepoPath) });
  }

  it("registers a fresh skill — advances main, writes DB rows, deletes branch", async () => {
    const runner = await makeRunner();
    const sha = await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });

    const result = await runner.register({ branch: "skill/echo", origin: OWNER });
    assertStatus(result, "live");
    expect(result.name).toBe("echo");
    expect(result.gitSha).toBe(sha);
    // ECHO declares and does nothing, which the table rates `auto`; with no
    // review panel (`no_review_panel`) it is capped at `notify`, so it goes
    // live with a message.
    expect(result.riskTier).toBe("notify");

    // main now points at the branch tip.
    expect(await getMainSha(repo.bare)).toBe(sha);

    // skills row exists with correct sha + tier.
    const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
    expect(skill?.gitSha).toBe(sha);
    expect(skill?.tier).toBe("wasm");
    expect(skill?.disabled).toBe(false);

    // The result names the rows it wrote and the facts the outcome message shows.
    const deploy = await tx((trx) => store.getDeployById(trx, result.deployId));
    expect(result.skillId).toBe(skill?.id);
    expect(deploy?.skillId).toBe(skill?.id);
    expect(result.facts).toEqual({
      description: "a wasm skill that echoes one int field",
      effects: { declared: [], detected: [] },
      hosts: [],
      secrets: [],
      dependencies: [],
      schedule: null,
      reasons: ["no_review_panel"],
      priorGitSha: null,
    });

    // Feature branch deleted.
    await expect(
      execFileP("git", ["-C", repo.bare, "rev-parse", "refs/heads/skill/echo"]),
    ).rejects.toThrow();
  });

  it("a register whose transaction fails after update-ref keeps its branch, and the repeat goes live", async () => {
    // The commit fails after `applyFilesystem` moved main: the database rolls
    // back while main stays at the tip. The branch is deleted only after a
    // commit, so the repeat still has something to register and converges.
    const sha = await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    const failingCommit: SkillStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "executeRegister") {
          return async (...args: Parameters<SkillStore["executeRegister"]>) => {
            await target.executeRegister(...args);
            throw new Error("commit failed");
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failing = await makeRunner({ store: failingCommit });
    await expect(failing.register({ branch: "skill/echo", origin: OWNER })).rejects.toThrow(
      /commit failed/,
    );
    expect(await getMainSha(repo.bare)).toBe(sha);
    expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
    await expect(
      execFileP("git", ["-C", repo.bare, "rev-parse", "refs/heads/skill/echo"]),
    ).resolves.toBeDefined();

    const runner = await makeRunner();
    const repeat = await runner.register({ branch: "skill/echo", origin: OWNER });
    assertStatus(repeat, "live");
    expect(repeat.gitSha).toBe(sha);
    expect((await tx((trx) => store.getSkillByName(trx, "echo")))?.gitSha).toBe(sha);
    await expect(
      execFileP("git", ["-C", repo.bare, "rev-parse", "refs/heads/skill/echo"]),
    ).rejects.toThrow();
  });

  it("a branch delete that fails after the commit is logged, and the deploy is still live", async () => {
    const sha = await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    // The branch's ref directory read-only: `update-ref -d` cannot take the
    // lock to unlink the loose ref, while `refs/heads/main` in the parent
    // directory stays writable for the deploy itself.
    const refDir = join(repo.bare, "refs", "heads", "skill");
    await chmod(refDir, 0o555);
    try {
      const runner = await makeRunner();
      const result = await runner.register({ branch: "skill/echo", origin: OWNER });
      assertStatus(result, "live");
      expect(await getMainSha(repo.bare)).toBe(sha);
      await expect(
        execFileP("git", ["-C", repo.bare, "rev-parse", "refs/heads/skill/echo"]),
      ).resolves.toBeDefined();
    } finally {
      await chmod(refDir, 0o755);
    }
  });

  it("re-register with same branch tip is a no-op (idempotent)", async () => {
    const runner = await makeRunner();
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    const first = await runner.register({ branch: "skill/echo", origin: OWNER });
    assertStatus(first, "live");

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
    const second = await runner.register({ branch: "at-main", origin: OWNER });
    assertStatus(second, "no_op");
  });

  it("rejects as non-fast-forward when main moves while the register waits on its lock", async () => {
    const runner = await makeRunner();
    const base = await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    await runner.register({ branch: "skill/echo", origin: OWNER });
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo-mine",
      manifest: ECHO_MANIFEST,
      body: `${ECHO_BODY}\n# mine\n`,
    });
    await execFileP("git", ["-C", repo.work, "reset", "--hard", base]);
    const theirs = await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo-theirs",
      manifest: ECHO_MANIFEST,
      body: `${ECHO_BODY}\n# theirs\n`,
    });
    // A concurrent register of the same skill wins the advisory lock and
    // moves main after this one's pre-transaction checks passed.
    const executeRegister = store.executeRegister.bind(store);
    const spy = vi.spyOn(store, "executeRegister").mockImplementationOnce(async (trx, params) => {
      await execFileP("git", ["-C", repo.bare, "update-ref", "refs/heads/main", theirs]);
      return executeRegister(trx, params);
    });

    try {
      const result = await runner.register({ branch: "skill/echo-mine", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors).toEqual(["non_fast_forward: rebase branch onto main and retry"]);
      expect(await getMainSha(repo.bare)).toBe(theirs);
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
      expect(skill?.gitSha).toBe(base);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a non-fast-forward branch", async () => {
    const runner = await makeRunner();
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    await runner.register({ branch: "skill/echo", origin: OWNER });

    // Build a divergent branch: reset work to a fresh root commit (no
    // ancestor of main), push as `divergent`.
    await execFileP("git", ["-C", repo.work, "checkout", "--orphan", "fresh"]);
    await writeFile(
      skillFile(repo.work, "SKILL.md", "echo"),
      ECHO_MANIFEST.replace("name: echo", "name: alt"),
    );
    await writeFile(skillFile(repo.work, "skill.py", "echo"), ECHO_BODY);
    await execFileP("git", ["-C", repo.work, "add", "."]);
    await execFileP("git", ["-C", repo.work, "commit", "-m", "fresh root"]);
    await execFileP("git", ["-C", repo.work, "push", "origin", "fresh:refs/heads/divergent"]);

    const result = await runner.register({ branch: "divergent", origin: OWNER });
    assertStatus(result, "rejected");
    expect(result.errors?.[0]).toMatch(/non_fast_forward/);
  });

  it("an aborted signal stops the deploy before it commits", async () => {
    const runner = await makeRunner();
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    const mainBefore = await getMainSha(repo.bare);
    const reason = new Error("register deadline");

    await expect(
      runner.register({ branch: "skill/echo", origin: OWNER, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);

    expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
    expect(await getMainSha(repo.bare)).toBe(mainBefore);
  });

  it("an aborted signal rejects with its reason ahead of any validation", async () => {
    const runner = await makeRunner();
    const reason = new Error("register deadline");

    await expect(
      runner.register({ branch: "nope", origin: OWNER, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
  });

  it("an abort once the deploy transaction has started still commits and reports live", async () => {
    const controller = new AbortController();
    // The deadline passes while the transaction moves main.
    class AbortingStore extends DrizzleSkillStore {
      override executeRegister(
        trx: Parameters<DrizzleSkillStore["executeRegister"]>[0],
        params: Parameters<DrizzleSkillStore["executeRegister"]>[1],
      ) {
        return super.executeRegister(trx, {
          ...params,
          applyFilesystem: async () => {
            controller.abort(new Error("register deadline"));
            await params.applyFilesystem();
          },
        });
      }
    }
    const runner = await makeRunner({ store: new AbortingStore() });
    const sha = await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });

    const result = await runner.register({
      branch: "skill/echo",
      origin: OWNER,
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    assertStatus(result, "live");
    expect(await getMainSha(repo.bare)).toBe(sha);
    expect((await tx((trx) => store.getSkillByName(trx, "echo")))?.gitSha).toBe(sha);
  });

  it("rejects a missing branch", async () => {
    const runner = await makeRunner();
    const result = await runner.register({ branch: "nope", origin: OWNER });
    assertStatus(result, "rejected");
    expect(result.errors?.[0]).toMatch(/branch_not_found/);
  });

  it("rejects a branch missing SKILL.md", async () => {
    const runner = await makeRunner();
    await writeFile(skillFile(repo.work, "skill.py", "echo"), ECHO_BODY);
    await execFileP("git", ["-C", repo.work, "add", "."]);
    await execFileP("git", ["-C", repo.work, "commit", "-m", "no manifest"]);
    await execFileP("git", ["-C", repo.work, "push", "origin", "main:refs/heads/no-manifest"]);
    const result = await runner.register({ branch: "no-manifest", origin: OWNER });
    assertStatus(result, "rejected");
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
    const result = await runner.register({ branch: "bad", origin: OWNER });
    assertStatus(result, "rejected");
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("rejects an $async inputs schema and an outputs schema ajv cannot compile", async () => {
    const runner = await makeRunner();
    const manifest = `---
name: bad-schemas
description: a skill whose JSON Schemas cannot validate
tier: wasm
inputs:
  type: object
  $async: true
  properties: {}
outputs:
  type: not-a-type
---
`;
    await pushFeatureBranch({
      work: repo.work,
      branch: "bad-schemas",
      manifest,
      body: ECHO_BODY,
    });
    const result = await runner.register({ branch: "bad-schemas", origin: OWNER });
    assertStatus(result, "rejected");
    expect(result.errors).toEqual([
      "invalid_inputs_schema: $async schemas are not supported",
      expect.stringMatching(/^invalid_outputs_schema: /),
    ]);
    expect(await getMainSha(repo.bare)).toBe(repo.layout);
  });

  describe("dependencies", () => {
    const ECHO_LOCKFILE = `httpx==0.27.0 \\\n    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000\n`;

    it("rejects when dependencies are declared but requirements.lock is absent", async () => {
      const runner = await makeRunner();
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-deps",
        manifest: ECHO_WITH_DEPS,
        body: ECHO_BODY,
      });
      const result = await runner.register({ branch: "skill/echo-deps", origin: OWNER });
      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/requirements_lock_missing/);
      // main did not move — register failed before any update-ref.
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
      expect(skill).toBeUndefined();
    });

    it("rejects when requirements.lock is committed but empty", async () => {
      const runner = await makeRunner();
      await writeFile(skillFile(repo.work, "SKILL.md", "echo"), ECHO_WITH_DEPS);
      await writeFile(skillFile(repo.work, "skill.py", "echo"), ECHO_BODY);
      await writeFile(skillFile(repo.work, "requirements.lock", "echo"), "   \n");
      await execFileP("git", ["-C", repo.work, "add", "."]);
      await execFileP("git", [
        "-C",
        repo.work,
        "commit",
        "-m",
        "skill with empty lockfile",
        "--allow-empty",
      ]);
      await execFileP("git", [
        "-C",
        repo.work,
        "push",
        "-f",
        "origin",
        "HEAD:refs/heads/skill/echo-empty-lock",
      ]);
      const result = await runner.register({ branch: "skill/echo-empty-lock", origin: OWNER });
      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/requirements_lock_empty/);
    });

    it("stores lockfile_hash on success when deps + lockfile are committed", async () => {
      const runner = await makeRunner();
      await writeFile(skillFile(repo.work, "SKILL.md", "echo"), ECHO_WITH_DEPS);
      await writeFile(skillFile(repo.work, "skill.py", "echo"), ECHO_BODY);
      await writeFile(skillFile(repo.work, "requirements.lock", "echo"), ECHO_LOCKFILE);
      await execFileP("git", ["-C", repo.work, "add", "."]);
      await execFileP("git", [
        "-C",
        repo.work,
        "commit",
        "-m",
        "skill with locked deps",
        "--allow-empty",
      ]);
      await execFileP("git", [
        "-C",
        repo.work,
        "push",
        "-f",
        "origin",
        "HEAD:refs/heads/skill/echo-locked",
      ]);
      const result = await runner.register({ branch: "skill/echo-locked", origin: OWNER });
      assertStatus(result, "live");
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
      // sha256(ECHO_LOCKFILE) — hex length 64 is the schema-level shape.
      expect(skill?.lockfileHash).toMatch(/^[0-9a-f]{64}$/);
    });

    describe("wasm packages", () => {
      // Bundled by Pyodide at this version and pure Python: the compatibility
      // check asks neither PyPI nor the probe.
      async function pushBundledDeps(branch: string, spec: string): Promise<void> {
        await writeFile(
          skillFile(repo.work, "SKILL.md", "echo"),
          ECHO_WITH_DEPS.replace("httpx==0.27.0", spec),
        );
        await writeFile(skillFile(repo.work, "skill.py", "echo"), ECHO_BODY);
        await writeFile(
          skillFile(repo.work, "requirements.lock", "echo"),
          `${spec} \\\n    --hash=sha256:${"0".repeat(64)}\n`,
        );
        await execFileP("git", ["-C", repo.work, "add", "."]);
        await execFileP("git", ["-C", repo.work, "commit", "-m", branch, "--allow-empty"]);
        await execFileP("git", [
          "-C",
          repo.work,
          "push",
          "-f",
          "origin",
          `HEAD:refs/heads/${branch}`,
        ]);
      }

      async function registerResolvingTo(error: WasmPackagesError) {
        const resolvePackages = vi.fn(async () => err(error));
        const { wasm, pyodidePackageCacheDir } = offlineWasm(repo.bare);
        const runner = await makeRunner({
          pyodidePackageCacheDir,
          wasm: { ...wasm, resolvePackages },
        });
        await pushBundledDeps("skill/echo-wasm", "httpx==0.28.1");
        const result = await runner.register({ branch: "skill/echo-wasm", origin: OWNER });
        expect(resolvePackages).toHaveBeenCalledTimes(1);
        return result;
      }

      it("fills the boundary probe's cache from Pyodide's CDN on the host, and goes live without the probe when that fails", async () => {
        const { wasm, pyodidePackageCacheDir } = offlineWasm(repo.bare);
        const runner = await makeRunner({ pyodidePackageCacheDir, wasm });
        // Bundled by Pyodide at this version and native: the probe load-tests it.
        await pushBundledDeps("skill/echo-native", "pydantic-core==2.41.5");
        const result = await runner.register({ branch: "skill/echo-native", origin: OWNER });
        assertStatus(result, "live");
        const fetchImpl = expectDefined(wasm.fetchImpl, "fetchImpl");
        const bundled = (await loadBundledPackages())._unsafeUnwrap();
        const coreFile = expectDefined(
          bundled.packages.get("pydantic-core"),
          "pydantic-core",
        ).fileName;
        expect(fetchImpl).toHaveBeenCalledWith(
          `https://cdn.jsdelivr.net/pyodide/v${bundled.version}/full/${coreFile}`,
          expect.anything(),
        );
        // The offline fetch fails the fill, which fails open before any probe child.
        expect(expectDefined(wasm.probe, "probe").probeBuiltins).not.toHaveBeenCalled();
      });

      it("rejects as wasm_dependency_unavailable when a wheel fails its pinned hash", async () => {
        const result = await registerResolvingTo({
          kind: "hash_mismatch",
          spec: "idna==3.10",
          message: "idna-3.10-py3-none-any.whl hashes to sha256:aa",
        });
        assertStatus(result, "rejected");
        expect(result.errors).toEqual([
          expect.stringMatching(/^wasm_dependency_unavailable: hash_mismatch: idna==3\.10: /),
        ]);
        expect(await getMainSha(repo.bare)).toBe(repo.layout);
      });

      // The schema import loads what a run loads, so a register that cannot
      // fetch the packages cannot read the skill's schemas: a retry may clear it.
      it.each([
        {
          name: "the packages cannot be fetched",
          error: {
            kind: "network_failed",
            spec: "idna==3.10",
            message: "pypi lookup: ECONNRESET",
          },
        },
        {
          name: "a built-in fails Pyodide's pinned sha256, a verdict on the cache, not the lockfile",
          error: {
            kind: "builtin_integrity",
            fileName: "httpx-0.28.1-py3-none-any.whl",
            message: "the download hashes to sha256:aa",
          },
        },
        {
          name: "Pyodide's own lockfile cannot be read",
          error: { kind: "bundled_unreadable", message: "pyodide-lock.json: ENOENT" },
        },
      ] satisfies { name: string; error: WasmPackagesError }[])(
        "rejects for a retry when $name, and commits nothing",
        async ({ error }) => {
          const result = await registerResolvingTo(error);

          assertStatus(result, "rejected");
          expect(result.errors).toEqual([
            expect.stringMatching(
              new RegExp(
                `^schema_import_unavailable: the skill's packages were not fetched \\(${error.kind}: .*\\); retry the register$`,
              ),
            ),
          ]);
          expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
        },
      );
    });

    it("an abort during the PyPI lookups rejects with its reason and commits nothing", async () => {
      // A dependency Pyodide doesn't bundle, so the compatibility check asks PyPI.
      const lockfile = "cogmo-unbundled==1.0.0 \\\n    --hash=sha256:0\n";
      await writeFile(
        skillFile(repo.work, "SKILL.md", "echo"),
        ECHO_WITH_DEPS.replace("httpx==0.27.0", "cogmo-unbundled==1.0.0"),
      );
      await writeFile(skillFile(repo.work, "skill.py", "echo"), ECHO_BODY);
      await writeFile(skillFile(repo.work, "requirements.lock", "echo"), lockfile);
      await execFileP("git", ["-C", repo.work, "add", "."]);
      await execFileP("git", ["-C", repo.work, "commit", "-m", "unbundled dep", "--allow-empty"]);
      await execFileP("git", [
        "-C",
        repo.work,
        "push",
        "-f",
        "origin",
        "HEAD:refs/heads/skill/echo-pypi",
      ]);
      const mainBefore = await getMainSha(repo.bare);
      const controller = new AbortController();
      const reason = new Error("register deadline");
      // The compatibility check's PyPI lookup is the injected fetch; it aborts
      // the register from inside the first call.
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        controller.abort(reason);
        return new Response(null, { status: 404 });
      });
      const runner = await makeRunner({
        wasm: { ...offlineWasm(repo.bare).wasm, fetchImpl: fetch },
      });

      await expect(
        runner.register({ branch: "skill/echo-pypi", origin: OWNER, signal: controller.signal }),
      ).rejects.toBe(reason);

      expect(fetch).toHaveBeenCalled();
      expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
      expect(await getMainSha(repo.bare)).toBe(mainBefore);
    });

    it("stores null lockfile_hash when manifest declares no deps", async () => {
      const runner = await makeRunner();
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-nodeps",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      const result = await runner.register({ branch: "skill/echo-nodeps", origin: OWNER });
      assertStatus(result, "live");
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
      expect(skill?.lockfileHash).toBeNull();
    });

    describe("compiler verification", () => {
      async function commitWithLockfile(branch: string, lockfile: string): Promise<string> {
        await writeFile(skillFile(repo.work, "SKILL.md", "echo"), ECHO_WITH_DEPS);
        await writeFile(skillFile(repo.work, "skill.py", "echo"), ECHO_BODY);
        await writeFile(skillFile(repo.work, "requirements.lock", "echo"), lockfile);
        await execFileP("git", ["-C", repo.work, "add", "."]);
        await execFileP("git", [
          "-C",
          repo.work,
          "commit",
          "-m",
          `update ${branch}`,
          "--allow-empty",
        ]);
        await execFileP("git", [
          "-C",
          repo.work,
          "push",
          "-f",
          "origin",
          `HEAD:refs/heads/${branch}`,
        ]);
        const { stdout } = await execFileP("git", ["-C", repo.work, "rev-parse", "HEAD"]);
        return stdout.trim();
      }

      it("accepts when fresh compile byte-matches the committed lockfile", async () => {
        const lockfile = "httpx==0.27.0 --hash=sha256:0\n";
        const compiler = { compile: vi.fn().mockResolvedValue(ok(lockfile)) };
        const runner = await makeRunner({ lockfileCompiler: compiler });
        await commitWithLockfile("skill/echo-verified", lockfile);

        const result = await runner.register({ branch: "skill/echo-verified", origin: OWNER });
        assertStatus(result, "live");
        expect(compiler.compile).toHaveBeenCalledWith(["httpx==0.27.0"], {});
      });

      it("rejects a fresh lockfile that pins pydantic at another version than the runtime's", async () => {
        const lockfile = "httpx==0.27.0 --hash=sha256:0\npydantic==2.14.3 --hash=sha256:1\n";
        const compiler = { compile: vi.fn().mockResolvedValue(ok(lockfile)) };
        const runner = await makeRunner({ lockfileCompiler: compiler });
        await commitWithLockfile("skill/echo-pydantic", lockfile);

        const result = await runner.register({ branch: "skill/echo-pydantic", origin: OWNER });
        assertStatus(result, "rejected");
        expect(result.errors?.[0]).toMatch(
          /^runtime_package_conflict: requirements\.lock pins pydantic==2\.14\.3 \(the runtime's is 2\.12\.5\)/,
        );
        expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
      });

      it("rejects with requirements_lock_stale when the compile output differs", async () => {
        const committed = "httpx==0.27.0 --hash=sha256:OLD\n";
        const fresh = "httpx==0.27.0 --hash=sha256:NEW\n";
        const compiler = { compile: vi.fn().mockResolvedValue(ok(fresh)) };
        const runner = await makeRunner({ lockfileCompiler: compiler });
        await commitWithLockfile("skill/echo-stale", committed);

        const result = await runner.register({ branch: "skill/echo-stale", origin: OWNER });
        assertStatus(result, "rejected");
        expect(result.errors?.[0]).toMatch(/requirements_lock_stale/);
        // main did NOT advance — the skill never went live.
        const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
        expect(skill).toBeUndefined();
      });

      it("rejects with resolver_failed when the compiler reports a resolver error", async () => {
        const compiler = {
          compile: vi.fn().mockResolvedValue(
            err({
              kind: "resolver_failed" as const,
              message: "Distribution not found at: bogus==0",
            }),
          ),
        };
        const runner = await makeRunner({ lockfileCompiler: compiler });
        await commitWithLockfile("skill/echo-bad", "anything\n");

        const result = await runner.register({ branch: "skill/echo-bad", origin: OWNER });
        assertStatus(result, "rejected");
        expect(result.errors?.[0]).toMatch(/requirements_lock_resolver_failed/);
        expect(result.errors?.[0]).toMatch(/Distribution not found/);
      });

      it("an abort during the compile rejects with its reason and commits nothing", async () => {
        const lockfile = "httpx==0.27.0 --hash=sha256:0\n";
        const controller = new AbortController();
        const reason = new Error("register deadline");
        // The deadline passes while the resolver runs; the abort disposes the
        // exec, which the compiler reports as a transport failure.
        const compiler = {
          compile: vi.fn(async () => {
            controller.abort(reason);
            return err({ kind: "transport_failed" as const, message: "exec was disposed" });
          }),
        };
        const runner = await makeRunner({ lockfileCompiler: compiler });
        const sha = await commitWithLockfile("skill/echo-aborted", lockfile);
        const mainBefore = await getMainSha(repo.bare);

        await expect(
          runner.register({
            branch: "skill/echo-aborted",
            origin: OWNER,
            signal: controller.signal,
          }),
        ).rejects.toBe(reason);

        expect(compiler.compile).toHaveBeenCalledWith(["httpx==0.27.0"], {
          signal: controller.signal,
        });
        expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
        expect(await getMainSha(repo.bare)).toBe(mainBefore);
        // The branch is left for a retry.
        const { stdout } = await execFileP("git", [
          "-C",
          repo.bare,
          "rev-parse",
          "refs/heads/skill/echo-aborted",
        ]);
        expect(stdout.trim()).toBe(sha);
      });

      it("an aborted signal starts no compile", async () => {
        const lockfile = "httpx==0.27.0 --hash=sha256:0\n";
        const compiler = { compile: vi.fn().mockResolvedValue(ok(lockfile)) };
        const runner = await makeRunner({ lockfileCompiler: compiler });
        await commitWithLockfile("skill/echo-dead", lockfile);
        const reason = new Error("register deadline");

        await expect(
          runner.register({
            branch: "skill/echo-dead",
            origin: OWNER,
            signal: AbortSignal.abort(reason),
          }),
        ).rejects.toBe(reason);
        expect(compiler.compile).not.toHaveBeenCalled();
      });

      it("skips compile when no compiler is configured (wasm-only deployment)", async () => {
        const lockfile = "httpx==0.27.0 --hash=sha256:0\n";
        // No compiler — default constructor wires one only when `sandbox`
        // is configured, and this test harness never sets `sandbox`, so
        // `#lockfileCompiler` lands undefined.
        const runner = await makeRunner();
        await commitWithLockfile("skill/echo-no-compiler", lockfile);

        const result = await runner.register({ branch: "skill/echo-no-compiler", origin: OWNER });
        assertStatus(result, "live");
        const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
        expect(skill?.lockfileHash).toMatch(/^[0-9a-f]{64}$/);
      });
    });
  });

  it("invokes the skill end-to-end after register (source loaded from git)", async () => {
    const runner = await makeRunner();
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo",
      manifest: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    await runner.register({ branch: "skill/echo", origin: OWNER });

    const result = (
      await runner.invoke({ name: "echo", inputs: { x: 7 }, runAs: await seededRunAs() })
    )._unsafeUnwrap();
    assertStatus(result, "success");
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
    await r1.register({ branch: "skill/echo", origin: OWNER });

    const r2 = await makeRunner();
    const result = (
      await r2.invoke({ name: "echo", inputs: { x: 7 }, runAs: await seededRunAs() })
    )._unsafeUnwrap();
    assertStatus(result, "success");
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
    await runner.register({ branch: "skill/bad-out", origin: OWNER });
    const result = (
      await runner.invoke({ name: "bad-out", inputs: { x: 1 }, runAs: await seededRunAs() })
    )._unsafeUnwrap();
    assertStatus(result, "error");
    expect(result.errorKind).toBe("output_invalid");
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
    await runner.register({ branch: "skill/echo", origin: OWNER });

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
    await runner.register({ branch: "skill/echo", origin: OWNER });

    const updatedManifest = ECHO_MANIFEST.replace(
      "a wasm skill that echoes one int field",
      "v2 now adds two instead",
    );
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo-v2",
      manifest: updatedManifest,
      body: ECHO_BODY,
    });
    const second = await runner.register({ branch: "skill/echo-v2", origin: OWNER });
    assertStatus(second, "live");

    const defs = await runner.listToolDefs();
    expect(defs[0]?.description).toContain("v2 now adds two instead");
  });

  describe("skills/<name>/ layout", () => {
    /** Commit `files` (paths from the repo root) on a branch off main and push it. */
    async function pushFiles(
      branch: string,
      files: Record<string, string>,
      opts: { message?: string; env?: Record<string, string> } = {},
    ): Promise<string> {
      await resetToMain(repo);
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(repo.work, path, ".."), { recursive: true });
        await writeFile(join(repo.work, path), content);
      }
      await execFileP("git", ["-C", repo.work, "add", "-A"]);
      await execFileP("git", ["-C", repo.work, "commit", "-q", "-m", opts.message ?? branch], {
        env: { ...process.env, ...opts.env },
      });
      await execFileP("git", [
        "-C",
        repo.work,
        "push",
        "-q",
        "-f",
        "origin",
        `HEAD:refs/heads/${branch}`,
      ]);
      return git(repo.work, "rev-parse", "HEAD");
    }

    it("refuses skill files at the repo root as layout_violation", async () => {
      const runner = await makeRunner();
      await pushFiles("skill/root", { "SKILL.md": ECHO_MANIFEST, "skill.py": ECHO_BODY });

      const result = await runner.register({ branch: "skill/root", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors).toEqual([
        "layout_violation: SKILL.md, skill.py at the repo root; a skill's files live in skills/<name>/",
      ]);
      expect(await getMainSha(repo.bare)).toBe(repo.layout);
    });

    it("refuses a path outside the skill's own files", async () => {
      const runner = await makeRunner();
      await pushFiles("skill/extra", {
        "skills/echo/SKILL.md": ECHO_MANIFEST,
        "skills/echo/skill.py": ECHO_BODY,
        "skills/echo/helpers.py": "x = 1\n",
        "pyproject.toml": "",
      });

      const result = await runner.register({ branch: "skill/extra", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(
        /^owned_paths: pyproject.toml, skills\/echo\/helpers.py outside/,
      );
    });

    it("refuses a branch that changes two skills", async () => {
      const runner = await makeRunner();
      await pushFiles("skill/two", {
        "skills/echo/SKILL.md": ECHO_MANIFEST,
        "skills/echo/skill.py": ECHO_BODY,
        "skills/other/SKILL.md": ECHO_MANIFEST.replace("name: echo", "name: other"),
        "skills/other/skill.py": ECHO_BODY,
      });

      const result = await runner.register({ branch: "skill/two", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors).toEqual([
        "owned_paths: the branch changes more than one skill: echo, other",
      ]);
    });

    it("refuses a commit made under Cogmo's identity", async () => {
      const runner = await makeRunner();
      const sha = await pushFiles(
        "skill/forged",
        { "skills/echo/SKILL.md": ECHO_MANIFEST, "skills/echo/skill.py": ECHO_BODY },
        { env: { GIT_COMMITTER_NAME: "Cogmo", GIT_COMMITTER_EMAIL: "skills@cogmo.invalid" } },
      );

      const result = await runner.register({ branch: "skill/forged", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toBe(
        `layout_violation: ${sha.slice(0, 7)} carry Cogmo's commit identity or a Cogmo- trailer, which only Cogmo's own commits may`,
      );
    });

    it("refuses a commit carrying a Cogmo- trailer", async () => {
      const runner = await makeRunner();
      await pushFiles(
        "skill/trailer",
        { "skills/echo/SKILL.md": ECHO_MANIFEST, "skills/echo/skill.py": ECHO_BODY },
        { message: `add echo\n\nCogmo-Restores: ${repo.layout}` },
      );

      const result = await runner.register({ branch: "skill/trailer", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(
        /^layout_violation: [0-9a-f]{7} carry Cogmo's commit identity/,
      );
    });

    it("refuses any Cogmo- trailer, not only the ones Cogmo writes today", async () => {
      const runner = await makeRunner();
      await pushFiles(
        "skill/trailer-any",
        { "skills/echo/SKILL.md": ECHO_MANIFEST, "skills/echo/skill.py": ECHO_BODY },
        { message: "add echo\n\nCogmo-Reviewed: abc" },
      );

      const result = await runner.register({ branch: "skill/trailer-any", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/^layout_violation: /);
    });

    it("refuses a branch at main where more than one skill differs from its live version", async () => {
      const runner = await makeRunner();
      for (const name of ["echo", "other"]) {
        await resetToMain(repo);
        await pushFeatureBranch({
          work: repo.work,
          branch: `skill/${name}`,
          manifest: ECHO_MANIFEST.replace("name: echo", `name: ${name}`),
          body: ECHO_BODY,
        });
        assertStatus(await runner.register({ branch: `skill/${name}`, origin: OWNER }), "live");
      }
      // The database falls behind main for both, as two crashed commits would leave it.
      await db.execute(sql`UPDATE skills SET git_sha = ${repo.layout}`);
      await git(repo.bare, "update-ref", "refs/heads/skill/at-main", "main");

      const result = await runner.register({ branch: "skill/at-main", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors).toEqual([
        "owned_paths: more than one skill differs from its live version at the tip: echo, other",
      ]);
    });

    it("refuses a directory whose manifest names another skill", async () => {
      const runner = await makeRunner();
      await pushFiles("skill/misnamed", {
        "skills/echo/SKILL.md": ECHO_MANIFEST.replace("name: echo", "name: other"),
        "skills/echo/skill.py": ECHO_BODY,
      });

      const result = await runner.register({ branch: "skill/misnamed", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors).toEqual([
        "skill_name_mismatch: skills/echo/SKILL.md names the skill 'other'; its directory must be skills/other/",
      ]);
    });

    it("a repeat after update-ref landed and the commit failed puts the tip live", async () => {
      const runner = await makeRunner();
      const sha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      const real = DrizzleSkillStore.prototype.executeRegister.bind(store);
      const failing = vi
        .spyOn(store, "executeRegister")
        .mockImplementationOnce(async (trx, params) => {
          await real(trx, params);
          throw new Error("commit failed");
        });
      await expect(runner.register({ branch: "skill/echo", origin: OWNER })).rejects.toThrow(
        "commit failed",
      );
      failing.mockRestore();
      // main holds the tip, the database nothing, and the branch survives.
      expect(await getMainSha(repo.bare)).toBe(sha);
      expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();

      const repeat = await runner.register({ branch: "skill/echo", origin: OWNER });

      assertStatus(repeat, "live");
      expect(repeat.gitSha).toBe(sha);
      expect((await tx((trx) => store.getSkillByName(trx, "echo")))?.gitSha).toBe(sha);
    });

    it("a branch left at a live tip is no_op", async () => {
      const runner = await makeRunner();
      const sha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      assertStatus(await runner.register({ branch: "skill/echo", origin: OWNER }), "live");
      await git(repo.bare, "update-ref", "refs/heads/skill/left", sha);

      const left = await runner.register({ branch: "skill/left", origin: OWNER });

      assertStatus(left, "no_op");
      expect(left.name).toBe("echo");
    });

    it("a branch at main whose skill's live sha the repo no longer has puts main's files live", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v1",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      assertStatus(await runner.register({ branch: "skill/echo-v1", origin: OWNER }), "live");
      const v2 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v2",
        manifest: ECHO_MANIFEST.replace("echoes one int field", "v2"),
        body: ECHO_BODY,
      });
      assertStatus(await runner.register({ branch: "skill/echo-v2", origin: OWNER }), "live");
      await restoreMainTo(repo, v1, v2);
      await git(repo.bare, "update-ref", "refs/heads/skill/at-main", v1);

      const result = await runner.register({ branch: "skill/at-main", origin: OWNER });

      assertStatus(result, "live");
      expect(result.gitSha).toBe(v1);
      expect((await tx((trx) => store.getSkillByName(trx, "echo")))?.gitSha).toBe(v1);
    });

    it("refuses a branch at main that changes no skill", async () => {
      const runner = await makeRunner();
      await git(repo.bare, "update-ref", "refs/heads/skill/empty", repo.layout);

      const result = await runner.register({ branch: "skill/empty", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors).toEqual(["nothing_to_register: the branch changes no skill"]);
    });

    it("enable accepts a forward rollback to a target that went live", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v1",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v1", origin: OWNER });
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v2",
        manifest: ECHO_MANIFEST.replace("echoes one int field", "v2"),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v2", origin: OWNER });
      const rolled = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });
      assertStatus(rolled, "live");
      await runner.deregister({ name: "echo" });

      const enabled = await runner.enable({ name: "echo", origin: OWNER });

      expect(enabled).toMatchObject({ kind: "enabled", gitSha: rolled.gitSha });
    });
  });

  describe("shas from before the layout commit", () => {
    let legacyAlpha = "";
    let legacyBeta = "";

    /** alpha, then beta, deployed at the repo root before the layout move. */
    async function setupLegacyRepo(): Promise<RepoSetup> {
      return setupRepo({
        beforeLayout: async (bare) => {
          const seed = await mkdtemp(join(tmpdir(), "skills-legacy-"));
          try {
            await execFileP("git", ["init", "-q", "-b", "main", seed]);
            const commit = async (name: string, body: string) => {
              await writeFile(
                join(seed, "SKILL.md"),
                ECHO_MANIFEST.replace("name: echo", `name: ${name}`),
              );
              await writeFile(join(seed, "skill.py"), body);
              await execFileP("git", ["-C", seed, "add", "-A"]);
              await execFileP("git", [
                "-C",
                seed,
                "-c",
                "user.email=legacy@test",
                "-c",
                "user.name=legacy",
                "commit",
                "-q",
                "-m",
                name,
              ]);
              const sha = await git(seed, "rev-parse", "HEAD");
              await execFileP("git", ["-C", seed, "push", "-q", bare, `HEAD:refs/heads/${name}`]);
              await git(bare, "update-ref", "refs/heads/main", sha);
              await tx((trx) =>
                store.insertSkill(trx, {
                  name,
                  tier: "wasm",
                  riskTier: "notify",
                  effects: [],
                  schedule: null,
                  scheduleNextRunAt: null,
                  gitSha: sha,
                  lockfileHash: null,
                  inputs: { type: "object" },
                  outputs: null,
                  scheduleRunAs: null,
                }),
              );
              return sha;
            };
            legacyAlpha = await commit("alpha", ECHO_BODY);
            legacyBeta = await commit("beta", ECHO_BODY_BAD_OUTPUT);
          } finally {
            await rm(seed, { recursive: true, force: true });
          }
        },
      });
    }

    it("rolls back to a legacy sha by restoring skills/<name>/ from its root files", async () => {
      const legacy = await setupLegacyRepo();
      try {
        const runner = await makeRunnerFor(legacy.bare);
        await execFileP("git", ["-C", legacy.work, "fetch", "-q", "origin", "main"]);
        await execFileP("git", ["-C", legacy.work, "reset", "-q", "--hard", "FETCH_HEAD"]);
        await pushFeatureBranch({
          work: legacy.work,
          branch: "skill/alpha-v2",
          manifest: ECHO_MANIFEST.replace("name: echo", "name: alpha").replace(
            "echoes one int field",
            "v2",
          ),
          body: ECHO_BODY,
        });
        assertStatus(await runner.register({ branch: "skill/alpha-v2", origin: OWNER }), "live");

        const rolled = await runner.rollback({
          name: "alpha",
          toGitSha: legacyAlpha,
          origin: OWNER,
        });

        assertStatus(rolled, "live");
        expect(await git(legacy.bare, "rev-parse", `${rolled.gitSha}:skills/alpha/SKILL.md`)).toBe(
          await git(legacy.bare, "rev-parse", `${legacyAlpha}:SKILL.md`),
        );
        expect(
          (await runner.listToolDefs()).find((d) => d.name === "alpha")?.description,
        ).toContain("echoes one int field");
      } finally {
        await legacy.cleanup();
      }
    });

    it("refuses a legacy sha whose root files belong to another skill", async () => {
      const legacy = await setupLegacyRepo();
      try {
        const runner = await makeRunnerFor(legacy.bare);

        const result = await runner.rollback({
          name: "alpha",
          toGitSha: legacyBeta,
          origin: OWNER,
        });

        assertStatus(result, "rejected");
        expect(result.errors?.[0]).toMatch(
          /^target_skill_mismatch: target sha belongs to skill 'beta'/,
        );
      } finally {
        await legacy.cleanup();
      }
    });

    it("reads a skill still at its legacy sha from the repo root", async () => {
      const legacy = await setupLegacyRepo();
      try {
        const runner = await makeRunnerFor(legacy.bare);
        const defs = await runner.listToolDefs();
        expect(defs.map((d) => d.name).sort()).toEqual(["alpha", "beta"]);
      } finally {
        await legacy.cleanup();
      }
    });
  });

  describe("rollback", () => {
    it("restores a prior version in a forward commit on main", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v1",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v1", origin: OWNER });

      const updatedManifest = ECHO_MANIFEST.replace(
        "a wasm skill that echoes one int field",
        "v2 description",
      );
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v2",
        manifest: updatedManifest,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v2", origin: OWNER });

      const v2 = expectDefined(await getMainSha(repo.bare), "main");
      const result = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });
      assertStatus(result, "live");
      // The facts are the restored version's, replacing v2.
      expect(result.facts).toMatchObject({
        description: "a wasm skill that echoes one int field",
        priorGitSha: v2,
      });
      const restoring = result.gitSha;
      const deploy = await tx((trx) => store.getDeployById(trx, result.deployId));
      expect(deploy).toMatchObject({
        status: "rolled_back",
        gitSha: restoring,
        restoresGitSha: v1,
      });

      // main fast-forwards to the restoring commit: Cogmo's, on top of v2,
      // with v1's files in skills/echo/.
      expect(await getMainSha(repo.bare)).toBe(restoring);
      expect(await git(repo.bare, "rev-parse", `${restoring}^`)).toBe(v2);
      expect(await git(repo.bare, "log", "-1", "--format=%ae %ce%n%B", restoring)).toMatch(
        new RegExp(`^skills@cogmo.invalid skills@cogmo.invalid\n[^]*\nCogmo-Restores: ${v1}$`),
      );
      expect(await git(repo.bare, "rev-parse", `${restoring}:skills/echo`)).toBe(
        await git(repo.bare, "rev-parse", `${v1}:skills/echo`),
      );
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
      expect(skill?.gitSha).toBe(restoring);
    });

    it("leaves another skill's later deploy on main", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v1",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v1", origin: OWNER });
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v2",
        manifest: ECHO_MANIFEST.replace("echoes one int field", "v2"),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v2", origin: OWNER });
      const other = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/other",
        manifest: ECHO_MANIFEST.replace("name: echo", "name: other"),
        body: ECHO_BODY,
      });
      assertStatus(await runner.register({ branch: "skill/other", origin: OWNER }), "live");

      const result = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });
      assertStatus(result, "live");

      expect(await git(repo.bare, "rev-parse", `${result.gitSha}^`)).toBe(other);
      expect(await git(repo.bare, "rev-parse", `${result.gitSha}:skills/other`)).toBe(
        await git(repo.bare, "rev-parse", `${other}:skills/other`),
      );
      const otherRow = await tx((trx) => store.getSkillByName(trx, "other"));
      expect(otherRow?.gitSha).toBe(other);
      expect(await isAncestorIn(repo.bare, other, result.gitSha)).toBe(true);
    });

    it("a rollback to a restoring commit restores that commit's own target", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v1",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v1", origin: OWNER });
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v2",
        manifest: ECHO_MANIFEST.replace("echoes one int field", "v2"),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v2", origin: OWNER });
      const v2 = expectDefined(await getMainSha(repo.bare), "main");
      const first = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });
      assertStatus(first, "live");
      // Forward again to v2, then back to the first restoring commit.
      assertStatus(await runner.rollback({ name: "echo", toGitSha: v2, origin: OWNER }), "live");

      const again = await runner.rollback({ name: "echo", toGitSha: first.gitSha, origin: OWNER });

      assertStatus(again, "live");
      const deploy = await tx((trx) => store.getDeployById(trx, again.deployId));
      expect(deploy?.restoresGitSha).toBe(v1);
      expect(
        await git(
          repo.bare,
          "log",
          "-1",
          "--format=%(trailers:key=Cogmo-Restores,valueonly)",
          again.gitSha,
        ),
      ).toBe(v1);
    });

    it("a repeat after the restoring commit landed with no row records that commit", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v1",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v1", origin: OWNER });
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v2",
        manifest: ECHO_MANIFEST.replace("echoes one int field", "v2"),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v2", origin: OWNER });
      const v2 = expectDefined(await getMainSha(repo.bare), "main");
      // The transaction fails after `update-ref` moved main.
      const real = DrizzleSkillStore.prototype.executeRollback.bind(store);
      const failing = vi
        .spyOn(store, "executeRollback")
        .mockImplementationOnce(async (trx, params) => {
          await real(trx, params);
          throw new Error("commit failed");
        });
      await expect(runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER })).rejects.toThrow(
        "commit failed",
      );
      failing.mockRestore();
      const landed = expectDefined(await getMainSha(repo.bare), "main");
      expect(landed).not.toBe(v2);
      expect((await tx((trx) => store.getSkillByName(trx, "echo")))?.gitSha).toBe(v2);

      const repeat = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });

      assertStatus(repeat, "live");
      expect(repeat.gitSha).toBe(landed);
      expect(await getMainSha(repo.bare)).toBe(landed);
    });

    it("a rollback to a denied first deploy's sha puts its files on main", async () => {
      const runner = await makeRunner();
      const denied = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/notifier",
        manifest: `---
name: notifier
description: a skill that sends notifications to the user
tier: wasm
inputs:
  type: object
  properties: {}
effects:
  - sends_message
---
`,
        body: ECHO_BODY,
      });
      const pending = await runner.register({ branch: "skill/notifier", origin: OWNER });
      assertStatus(pending, "pending_approval");
      expect(await runner.denyDeploy({ pendingId: pending.deployId })).toEqual(ok(undefined));

      const rolled = await runner.rollback({ name: "notifier", toGitSha: denied, origin: OWNER });

      assertStatus(rolled, "live");
      const main = expectDefined(await getMainSha(repo.bare), "main");
      expect(main).toBe(rolled.gitSha);
      expect(await git(repo.bare, "rev-parse", `${main}:skills/notifier`)).toBe(
        await git(repo.bare, "rev-parse", `${denied}:skills/notifier`),
      );
    });

    it("a recovered restoring commit is refused when main moves under the rollback", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v1",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v1", origin: OWNER });
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v2",
        manifest: ECHO_MANIFEST.replace("echoes one int field", "v2"),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v2", origin: OWNER });
      const v2 = expectDefined(await getMainSha(repo.bare), "main");
      const real = DrizzleSkillStore.prototype.executeRollback.bind(store);
      vi.spyOn(store, "executeRollback").mockImplementationOnce(async (trx, params) => {
        await real(trx, params);
        throw new Error("commit failed");
      });
      await expect(runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER })).rejects.toThrow(
        "commit failed",
      );
      // The repeat finds the restoring commit; another deploy lands on main
      // before its transaction.
      vi.spyOn(store, "executeRollback").mockImplementationOnce(async (trx, params) => {
        const tree = await git(repo.bare, "rev-parse", "main^{tree}");
        const moved = (
          await execFileP(
            "git",
            ["-C", repo.bare, "commit-tree", tree, "-p", "main", "-m", "moved"],
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
        await git(repo.bare, "update-ref", "refs/heads/main", moved);
        return real(trx, params);
      });

      const repeat = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });

      assertStatus(repeat, "rejected");
      expect(repeat.errors).toEqual(["main_moved: main changed during the rollback; retry"]);
      expect((await tx((trx) => store.getSkillByName(trx, "echo")))?.gitSha).toBe(v2);
    });

    it("a disabled skill rolled back to its own version is enabled with main left as is", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo", origin: OWNER });
      await runner.deregister({ name: "echo" });

      const rolled = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });

      assertStatus(rolled, "live");
      expect(await getMainSha(repo.bare)).toBe(v1);
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
      expect(skill).toMatchObject({ gitSha: v1, disabled: false });
    });

    it("a target whose files the live version already holds is a no-op", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v1",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v1", origin: OWNER });
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v2",
        manifest: ECHO_MANIFEST.replace("echoes one int field", "v2"),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo-v2", origin: OWNER });
      assertStatus(await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER }), "live");
      const main = await getMainSha(repo.bare);

      // v1 again: the restoring commit already holds its files.
      const repeat = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });

      assertStatus(repeat, "no_op");
      expect(await getMainSha(repo.bare)).toBe(main);
    });

    it("a rollback whose skill's live sha the repo no longer has restores the target", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v1",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      assertStatus(await runner.register({ branch: "skill/echo-v1", origin: OWNER }), "live");
      const v2 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v2",
        manifest: ECHO_MANIFEST.replace("echoes one int field", "v2"),
        body: ECHO_BODY,
      });
      assertStatus(await runner.register({ branch: "skill/echo-v2", origin: OWNER }), "live");
      await restoreMainTo(repo, v1, v2);

      const rolled = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });

      // main already holds v1's files, so it is the restoring commit.
      assertStatus(rolled, "live");
      expect(rolled.gitSha).toBe(v1);
      expect(await getMainSha(repo.bare)).toBe(v1);
      expect((await tx((trx) => store.getSkillByName(trx, "echo")))?.gitSha).toBe(v1);
    });

    it("rollback to current sha is a no-op", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo", origin: OWNER });

      const result = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });
      assertStatus(result, "no_op");
    });

    it("rollback succeeds even if a fresh compile would resolver_fail (yanked wheel)", async () => {
      // Compiler stub: register/approve calls succeed; any rollback-time
      // call would trip the resolver_failed path. Rollback MUST skip
      // verifyFresh so an upstream yank doesn't block rolling back to a
      // known-good revision.
      const compiler = {
        compile: vi
          .fn()
          .mockResolvedValueOnce(ok("httpx==0.27.0 --hash=sha256:OK\n"))
          .mockResolvedValue(
            err({ kind: "resolver_failed" as const, message: "wheel yanked upstream" }),
          ),
      };
      const runner = await makeRunner({ lockfileCompiler: compiler });

      const lockfile = "httpx==0.27.0 --hash=sha256:OK\n";
      await writeFile(skillFile(repo.work, "SKILL.md", "echo"), ECHO_WITH_DEPS);
      await writeFile(skillFile(repo.work, "skill.py", "echo"), ECHO_BODY);
      await writeFile(skillFile(repo.work, "requirements.lock", "echo"), lockfile);
      await execFileP("git", ["-C", repo.work, "add", "."]);
      await execFileP("git", ["-C", repo.work, "commit", "-m", "v1 with deps", "--allow-empty"]);
      await execFileP("git", [
        "-C",
        repo.work,
        "push",
        "-f",
        "origin",
        "HEAD:refs/heads/skill/echo-deps-v1",
      ]);
      const v1Result = await runner.register({ branch: "skill/echo-deps-v1", origin: OWNER });
      assertStatus(v1Result, "live");
      const v1Sha = v1Result.gitSha;

      // v2 — same lockfile bytes, only manifest description changes.
      const v2Manifest = ECHO_WITH_DEPS.replace(
        "a wasm skill that echoes one int field",
        "v2 description that is reasonably long",
      );
      await writeFile(skillFile(repo.work, "SKILL.md", "echo"), v2Manifest);
      await execFileP("git", ["-C", repo.work, "add", "."]);
      await execFileP("git", ["-C", repo.work, "commit", "-m", "v2 with same deps"]);
      await execFileP("git", [
        "-C",
        repo.work,
        "push",
        "-f",
        "origin",
        "HEAD:refs/heads/skill/echo-deps-v2",
      ]);
      compiler.compile.mockResolvedValueOnce(ok(lockfile));
      const v2Result = await runner.register({ branch: "skill/echo-deps-v2", origin: OWNER });
      assertStatus(v2Result, "live");

      // Rollback — compiler stub now reports yanked-wheel. Must still succeed.
      const rollbackResult = await runner.rollback({
        name: "echo",
        toGitSha: v1Sha,
        origin: OWNER,
      });
      assertStatus(rollbackResult, "live");
      const deploy = await tx((trx) => store.getDeployById(trx, rollbackResult.deployId));
      expect(deploy?.restoresGitSha).toBe(v1Sha);
    });
  });

  describe("deny", () => {
    it("reports an unknown id as not_found", async () => {
      const runner = await makeRunner();
      const pendingId = "00000000-0000-0000-0000-000000000000";
      expect(await runner.denyDeploy({ pendingId })).toEqual(err({ kind: "not_found", pendingId }));
    });
  });

  describe("schedule run-as", () => {
    const scheduledManifest = (effects: string) => `---
name: briefing
description: a scheduled skill
tier: wasm
inputs:
  type: object
  properties: {}
triggers: [manual, cron]
schedule: "0 9 * * *"
${effects}
---
`;

    async function seedUser(): Promise<string> {
      const [row] = await db.insert(users).values({}).returning({ id: users.id });
      return expectDefined(row, "user").id;
    }

    async function seedOwner(): Promise<SkillRunIdentity> {
      const userId = await seedUser();
      const [profile] = await db
        .insert(profiles)
        .values({ userId: null, name: "default", basePrompt: "", model: "m", toolSet: [] })
        .returning({ id: profiles.id });
      return { userId, profileId: expectDefined(profile, "profile").id };
    }

    async function seedActor(): Promise<SkillActor> {
      const userId = await seedUser();
      const [channel] = await db
        .insert(channels)
        .values({ type: "telegram", credentials: {}, identityMode: "mapped" })
        .returning({ id: channels.id });
      const [identity] = await db
        .insert(userIdentities)
        .values({
          userId,
          channelId: expectDefined(channel, "channel").id,
          platformHandle: `tg-${userId}`,
          isWildcard: false,
          autoCreated: false,
        })
        .returning({ id: userIdentities.id });
      return { identityId: expectDefined(identity, "identity").id, userId };
    }

    /** A conversation's identity: a user of its own with a persona profile. */
    async function seedConversationIdentity(): Promise<SkillRunIdentity> {
      const userId = await seedUser();
      return { userId, profileId: await seedPersona(userId) };
    }

    async function seedPersona(userId: string): Promise<string> {
      const [profile] = await db
        .insert(profiles)
        .values({ userId, name: "persona", basePrompt: "", model: "m", toolSet: [] })
        .returning({ id: profiles.id });
      return expectDefined(profile, "persona").id;
    }

    function fromConversation(identity: SkillRunIdentity): SkillDeployOrigin {
      return { kind: "conversation", ...identity };
    }

    async function runAsOfBriefing(): Promise<[string | null, string | null]> {
      const row = expectDefined(
        await tx((trx) => store.getSkillByName(trx, "briefing")),
        "briefing",
      );
      return [row.runAsUserId, row.runAsProfileId];
    }

    async function pendingBriefing(runner: SkillRunnerImpl): Promise<string> {
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/briefing",
        manifest: scheduledManifest("effects:\n  - sends_message"),
        body: ECHO_BODY,
      });
      const reg = await runner.register({ branch: "skill/briefing", origin: OWNER });
      if (reg.status !== "pending_approval" || !reg.deployId) {
        throw new Error(`expected pending_approval, got ${reg.status}`);
      }
      return reg.deployId;
    }

    async function liveBriefing(runner: SkillRunnerImpl, origin: SkillDeployOrigin): Promise<void> {
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/briefing",
        manifest: scheduledManifest(""),
        body: ECHO_BODY,
      });
      expect((await runner.register({ branch: "skill/briefing", origin })).status).toBe("live");
    }

    it("a scheduled register from the owner runs as the install owner with the default profile", async () => {
      const owner = await seedOwner();
      const runner = await makeRunner({ defaultRunAs: owner });

      await liveBriefing(runner, OWNER);

      expect(await runAsOfBriefing()).toEqual([owner.userId, owner.profileId]);
    });

    it("a scheduled register from a conversation runs as that conversation's user and profile", async () => {
      const runner = await makeRunner({ defaultRunAs: await seedOwner() });
      const origin = await seedConversationIdentity();

      await liveBriefing(runner, fromConversation(origin));

      expect(await runAsOfBriefing()).toEqual([origin.userId, origin.profileId]);
    });

    it("an approval with no conversation runs as the approver with the default profile", async () => {
      const owner = await seedOwner();
      const approver = await seedActor();
      const runner = await makeRunner({ defaultRunAs: owner });
      const pendingId = await pendingBriefing(runner);

      const approved = await runner.approveDeploy({
        pendingId,
        origin: { kind: "user", actor: approver, conversation: null },
      });

      assertStatus(approved, "live");
      expect(await runAsOfBriefing()).toEqual([approver.userId, owner.profileId]);
      const deploy = await tx((trx) => store.getDeployById(trx, pendingId));
      expect(deploy?.approvedBy).toBe(approver.identityId);
    });

    it("an approval in the approver's own conversation takes that conversation's profile", async () => {
      const approver = await seedActor();
      const runner = await makeRunner({ defaultRunAs: await seedOwner() });
      const pendingId = await pendingBriefing(runner);
      const conversation = {
        userId: approver.userId,
        profileId: await seedPersona(approver.userId),
      };

      await runner.approveDeploy({
        pendingId,
        origin: { kind: "user", actor: approver, conversation },
      });

      expect(await runAsOfBriefing()).toEqual([approver.userId, conversation.profileId]);
    });

    it("an approval in another user's conversation keeps the approver, not that profile", async () => {
      const owner = await seedOwner();
      const approver = await seedActor();
      const runner = await makeRunner({ defaultRunAs: owner });
      const pendingId = await pendingBriefing(runner);

      await runner.approveDeploy({
        pendingId,
        origin: { kind: "user", actor: approver, conversation: await seedConversationIdentity() },
      });

      expect(await runAsOfBriefing()).toEqual([approver.userId, owner.profileId]);
    });

    it("a pending result carries the pending manifest's schedule for the outcome message", async () => {
      const runner = await makeRunner({ defaultRunAs: await seedOwner() });
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/briefing",
        manifest: scheduledManifest("effects:\n  - sends_message"),
        body: ECHO_BODY,
      });

      const reg = await runner.register({ branch: "skill/briefing", origin: OWNER });

      expect(reg).toMatchObject({ status: "pending_approval", facts: { schedule: "0 9 * * *" } });
    });

    it("an owner approval records no approver and runs as the owner", async () => {
      const owner = await seedOwner();
      const runner = await makeRunner({ defaultRunAs: owner });
      const pendingId = await pendingBriefing(runner);

      await runner.approveDeploy({ pendingId, origin: OWNER });

      expect(await runAsOfBriefing()).toEqual([owner.userId, owner.profileId]);
      const deploy = await tx((trx) => store.getDeployById(trx, pendingId));
      expect(deploy?.approvedBy).toBeNull();
    });

    it("a rollback from a conversation runs as that conversation, not the deploy it restores", async () => {
      const runner = await makeRunner({ defaultRunAs: await seedOwner() });
      const author = fromConversation(await seedConversationIdentity());
      const firstSha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/briefing",
        manifest: scheduledManifest(""),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/briefing", origin: author });
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/briefing-v2",
        manifest: scheduledManifest(""),
        body: `${ECHO_BODY}\n# v2\n`,
      });
      await runner.register({ branch: "skill/briefing-v2", origin: author });
      const rollbackOrigin = await seedConversationIdentity();

      const rolled = await runner.rollback({
        name: "briefing",
        toGitSha: firstSha,
        origin: fromConversation(rollbackOrigin),
      });

      assertStatus(rolled, "live");
      expect(await runAsOfBriefing()).toEqual([rollbackOrigin.userId, rollbackOrigin.profileId]);
    });

    it("deregister leaves the schedule running as no one", async () => {
      const runner = await makeRunner({ defaultRunAs: await seedOwner() });
      await liveBriefing(runner, fromConversation(await seedConversationIdentity()));

      await runner.deregister({ name: "briefing" });

      expect(await runAsOfBriefing()).toEqual([null, null]);
    });

    it("enable runs the schedule as the enabler, not whoever deployed it", async () => {
      const owner = await seedOwner();
      const runner = await makeRunner({ defaultRunAs: owner });
      await liveBriefing(runner, OWNER);
      await runner.deregister({ name: "briefing" });
      const enabler = await seedActor();

      const result = await runner.enable({
        name: "briefing",
        origin: { kind: "user", actor: enabler, conversation: null },
      });

      // The schedule is returned so the reply can say it now runs as the enabler.
      expect(result).toMatchObject({ kind: "enabled", schedule: "0 9 * * *" });
      expect(await runAsOfBriefing()).toEqual([enabler.userId, owner.profileId]);
    });

    it("enable in the enabler's own conversation takes that conversation's profile", async () => {
      const runner = await makeRunner({ defaultRunAs: await seedOwner() });
      await liveBriefing(runner, OWNER);
      await runner.deregister({ name: "briefing" });
      const enabler = await seedActor();
      const conversation = { userId: enabler.userId, profileId: await seedPersona(enabler.userId) };

      await runner.enable({
        name: "briefing",
        origin: { kind: "user", actor: enabler, conversation },
      });

      expect(await runAsOfBriefing()).toEqual([enabler.userId, conversation.profileId]);
    });
  });

  // The approveDeploy / rollback rejection paths are the runner's
  // failure-mode contract — downstream code (Telegram approval keyboard
  // toast text, skills CLI exit codes) keys off the reason strings. Each
  // branch returns a distinct `rejectedResult(...)` reason; this block
  // exercises one per test so a string drift surfaces immediately.
  describe("approveDeploy: rejection matrix", () => {
    const APPROVE_MANIFEST = `---
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

    async function makePendingDeploy(runner: Awaited<ReturnType<typeof makeRunner>>) {
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/notifier",
        manifest: APPROVE_MANIFEST,
        body: ECHO_BODY,
      });
      const reg = await runner.register({ branch: "skill/notifier", origin: OWNER });
      if (reg.status !== "pending_approval" || !reg.deployId) {
        throw new Error(`expected pending_approval, got ${reg.status}`);
      }
      return reg.deployId;
    }

    it("deploy_not_found when pendingId doesn't exist", async () => {
      const runner = await makeRunner();
      const result = await runner.approveDeploy({
        pendingId: "00000000-0000-0000-0000-000000000099",
        origin: OWNER,
      });
      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/deploy_not_found/);
      expect(result.gitSha).toBe("");
    });

    it("deploy_not_pending on a second approve of the same pendingId", async () => {
      // Idempotency: the row is flipped to live after the first approve.
      // The second approve sees status='live' and short-circuits with a
      // distinct error code so the operator gets a useful toast instead of
      // a silent no-op.
      const runner = await makeRunner();
      const pendingId = await makePendingDeploy(runner);
      const first = await runner.approveDeploy({ pendingId, origin: OWNER });
      assertStatus(first, "live");

      const second = await runner.approveDeploy({ pendingId, origin: OWNER });
      assertStatus(second, "rejected");
      expect(second.errors?.[0]).toMatch(/deploy_not_pending/);
      expect(second.errors?.[0]).toMatch(/live/);
    });

    it("non_fast_forward_at_approve_time when main moved past deploy.gitSha", async () => {
      // Pending deploy A is created, then a different feature branch is
      // registered → main advances past A's sha. Approving A is no longer
      // a fast-forward.
      const runner = await makeRunner();
      const pendingId = await makePendingDeploy(runner);

      // A second, unrelated auto-tier skill lands first → main advances.
      // (`echo` declares no destructive effects, so it lands live.)
      await resetToMain(repo);
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-leap",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      const leap = await runner.register({ branch: "skill/echo-leap", origin: OWNER });
      assertStatus(leap, "live");

      // Now approve the original pending — main has moved.
      const result = await runner.approveDeploy({ pendingId, origin: OWNER });
      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/non_fast_forward_at_approve_time/);
    });

    it("rejects when another skill's deploy moves main while the approve waits on its lock", async () => {
      const runner = await makeRunner();
      const pendingId = await makePendingDeploy(runner);
      await execFileP("git", ["-C", repo.work, "checkout", "--orphan", "unrelated"]);
      const theirs = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/unrelated",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      const executeApprove = store.executeApprove.bind(store);
      const spy = vi.spyOn(store, "executeApprove").mockImplementationOnce(async (trx, params) => {
        await execFileP("git", ["-C", repo.bare, "update-ref", "refs/heads/main", theirs]);
        return executeApprove(trx, params);
      });

      try {
        const result = await runner.approveDeploy({ pendingId, origin: OWNER });

        assertStatus(result, "rejected");
        expect(result.errors).toEqual(["non_fast_forward_at_approve_time"]);
        expect(await getMainSha(repo.bare)).toBe(theirs);
        const deploy = await tx((trx) => store.getDeployById(trx, pendingId));
        expect(deploy?.status).toBe("pending_approval");
      } finally {
        spy.mockRestore();
      }
    });

    it("target_missing_source when SKILL.md is gone at the deploy sha", async () => {
      // Patch the deploy's git_sha column to point at a commit lacking
      // SKILL.md — simulates the original branch being rebased away
      // between register and approve so gitShow throws file_not_found.
      const runner = await makeRunner();
      const pendingId = await makePendingDeploy(runner);

      // Push a commit with no SKILL.md to a parallel branch.
      await execFileP("git", [
        "-C",
        repo.work,
        "rm",
        "skills/notifier/SKILL.md",
        "skills/notifier/skill.py",
      ]);
      await execFileP("git", [
        "-C",
        repo.work,
        "commit",
        "-m",
        "drop skill files",
        "--allow-empty",
      ]);
      const noFilesSha = (
        await execFileP("git", ["-C", repo.work, "rev-parse", "HEAD"])
      ).stdout.trim();
      await execFileP("git", [
        "-C",
        repo.work,
        "push",
        "origin",
        `HEAD:refs/heads/scratch-nofiles`,
      ]);

      // Patch the deploy row to point at the no-files sha. Direct SQL —
      // simulates the original branch having been rebased away.
      await tx(async (trx) => {
        await trx.execute(
          sql`UPDATE skill_deploys SET git_sha = ${noFilesSha} WHERE id = ${pendingId}`,
        );
      });

      const result = await runner.approveDeploy({ pendingId, origin: OWNER });
      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/target_missing_source/);
    });
  });

  describe("rollback: rejection matrix", () => {
    it("rejects when another deploy moves main while the rollback waits on its lock", async () => {
      const runner = await makeRunner();
      const v1 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo", origin: OWNER });
      const v2 = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-v2",
        manifest: ECHO_MANIFEST,
        body: `${ECHO_BODY}\n# v2\n`,
      });
      await runner.register({ branch: "skill/echo-v2", origin: OWNER });
      const theirs = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/other",
        manifest: ECHO_MANIFEST,
        body: `${ECHO_BODY}\n# other\n`,
      });
      const executeRollback = store.executeRollback.bind(store);
      const spy = vi.spyOn(store, "executeRollback").mockImplementationOnce(async (trx, params) => {
        await execFileP("git", ["-C", repo.bare, "update-ref", "refs/heads/main", theirs]);
        return executeRollback(trx, params);
      });

      try {
        const result = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });

        assertStatus(result, "rejected");
        expect(result.errors?.[0]).toMatch(/^main_moved:/);
        expect(await getMainSha(repo.bare)).toBe(theirs);
        const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
        expect(skill?.gitSha).toBe(v2);
      } finally {
        spy.mockRestore();
      }
    });

    it("target_sha_not_found when the target sha is unknown to the repo", async () => {
      const runner = await makeRunner();
      // Register echo first so the skill row exists.
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo", origin: OWNER });

      // A non-hex ref name that doesn't resolve. (Sha-shaped hex strings
      // pass `git rev-parse --verify` regardless of whether the object
      // actually exists — only a missing *ref* name triggers
      // ref_not_found from revParse.)
      const result = await runner.rollback({
        name: "echo",
        toGitSha: "refs/heads/totally-missing-ref",
        origin: OWNER,
      });
      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/target_sha_not_found/);
    });

    it("target_missing_source when SKILL.md is absent at the target sha", async () => {
      const runner = await makeRunner();
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo", origin: OWNER });

      // Push a commit with no SKILL.md to a parallel branch.
      await execFileP("git", [
        "-C",
        repo.work,
        "rm",
        "skills/echo/SKILL.md",
        "skills/echo/skill.py",
      ]);
      await execFileP("git", [
        "-C",
        repo.work,
        "commit",
        "-m",
        "drop skill files",
        "--allow-empty",
      ]);
      const noFilesSha = (
        await execFileP("git", ["-C", repo.work, "rev-parse", "HEAD"])
      ).stdout.trim();
      await execFileP("git", [
        "-C",
        repo.work,
        "push",
        "origin",
        `HEAD:refs/heads/scratch-nofiles`,
      ]);

      const result = await runner.rollback({ name: "echo", toGitSha: noFilesSha, origin: OWNER });
      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/target_missing_source/);
    });
  });

  describe("deregister", () => {
    it("soft-disables the skill; list excludes it; returns kind: deregistered", async () => {
      const runner = await makeRunner();
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/echo", origin: OWNER });

      const result = await runner.deregister({ name: "echo" });
      expect(result).toEqual({ kind: "deregistered", name: "echo" });

      const enabled = (await runner.listAll()).filter((s) => !s.disabled);
      expect(enabled).toHaveLength(0);
      // Row still exists for audit history.
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
      expect(skill?.disabled).toBe(true);
    });

    it("returns rejected:not_found for an unknown skill", async () => {
      const runner = await makeRunner();
      const result = await runner.deregister({ name: "missing" });
      expect(result).toEqual({ kind: "rejected", name: "missing", reason: "not_found" });
    });
  });

  // --- Review-comment regressions (cubic PR #112 review) ---

  describe("safety: register is locked away from main", () => {
    it("rejects branch == 'main' before touching git or DB", async () => {
      const runner = await makeRunner();
      const result = await runner.register({ branch: "main", origin: OWNER });
      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/invalid_branch/);
      // No skills row created.
      expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
    });

    it("rejects branch == 'refs/heads/main' too", async () => {
      const runner = await makeRunner();
      const result = await runner.register({ branch: "refs/heads/main", origin: OWNER });
      assertStatus(result, "rejected");
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
      const result = await runner.register({ branch: "skill/bad-schema", origin: OWNER });
      assertStatus(result, "rejected");
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
      const result = await runner.register({ branch: "skill/bad-properties", origin: OWNER });
      assertStatus(result, "rejected");
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
      const result = await runner.register({ branch: "skill/notifier", origin: OWNER });
      assertStatus(result, "pending_approval");
      expect(result.riskTier).toBe("approve");
      expect(result.deployId).toBeTruthy();
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
      const reg = await runner.register({ branch: "skill/notifier", origin: OWNER });
      assertStatus(reg, "pending_approval");
      const pendingId = reg.deployId;
      if (!pendingId) throw new Error("expected pendingId");

      expect(reg.facts).toMatchObject({
        description: "a skill that sends notifications to the user",
        effects: { declared: ["sends_message"] },
        priorGitSha: null,
      });

      const approved = await runner.approveDeploy({ pendingId, origin: OWNER });
      assertStatus(approved, "live");
      expect(approved.gitSha).toBe(sha);
      // Approve resolves the pending row and reports its facts.
      expect(approved.deployId).toBe(pendingId);
      expect(approved.skillId).toBe(reg.skillId);
      expect(approved.facts).toEqual(reg.facts);

      // main moved + skills row reflects the approved sha.
      expect(await getMainSha(repo.bare)).toBe(sha);
      const skill = await tx((trx) => store.getSkillByName(trx, "notifier"));
      expect(skill?.gitSha).toBe(sha);
      expect(skill?.disabled).toBe(false);
      // Manifest-derived columns projected from the approved sha.
      expect(skill?.effects).toEqual(["sends_message"]);
    });
  });

  describe("safety: AST classifier rejects manifest-vs-code drift", () => {
    it("body imports stripe + manifest declares no effects → register rejected with validation error", async () => {
      const runner = await makeRunner();
      // Body uses stripe without `financial` declared → the AST
      // classifier's UX gate fires. Deploy should be rejected before
      // main is advanced or any skills row is written. The vehicle is a
      // third-party import rather than a stdlib one so the wasm lint,
      // which runs first, has nothing to say about it.
      const offendingBody = `
import stripe
async def run(inputs, ctx):
    return {"echo": inputs["x"] + 1}
`;
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: offendingBody,
      });
      const before = await getMainSha(repo.bare);
      const result = await runner.register({ branch: "skill/echo", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/undeclared effect 'financial'/);
      expect(result.errors?.[0]).toMatch(/stripe/);
      // No advance, no skills row.
      expect(await getMainSha(repo.bare)).toBe(before);
      expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
    });

    it("body declares + uses financial → lands as pending_approval (no validation error, approve-tier)", async () => {
      const runner = await makeRunner();
      const okManifest = ECHO_MANIFEST.replace(
        "name: echo\n",
        "name: echo\neffects:\n  - financial\n",
      );
      const okBody = `
import stripe
async def run(inputs, ctx):
    stripe.Charge.create(amount=1)
    return {"echo": inputs["x"] + 1}
`;
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: okManifest,
        body: okBody,
      });
      const result = await runner.register({ branch: "skill/echo", origin: OWNER });
      assertStatus(result, "pending_approval");
      expect(result.riskTier).toBe("approve");
    });
  });

  describe("safety: wasm lint rejects bodies the wasm tier cannot run", () => {
    it("rejects a wasm body importing a stdlib networking module", async () => {
      const runner = await makeRunner();
      // Pyodide has no sockets, so this body would fail on first invoke
      // whatever the classifier made of it. The lint runs ahead of the
      // classifier and turns that into a rejection at deploy time.
      const networkBody = `
import smtplib
async def run(inputs, ctx):
    return {"echo": inputs["x"] + 1}
`;
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: networkBody,
      });
      const before = await getMainSha(repo.bare);
      const result = await runner.register({ branch: "skill/echo", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/stdlib networking/);
      expect(result.errors?.[0]).toMatch(/line 2/);
      expect(await getMainSha(repo.bare)).toBe(before);
      expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
    });

    it("rejects a wasm body importing subprocess", async () => {
      const runner = await makeRunner();
      const subprocessBody = `
import subprocess
async def run(inputs, ctx):
    return {"echo": inputs["x"] + 1}
`;
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: subprocessBody,
      });
      const result = await runner.register({ branch: "skill/echo", origin: OWNER });
      assertStatus(result, "rejected");
      expect(result.errors?.[0]).toMatch(/subprocess/);
    });
  });

  describe("safety: rollback verifies target sha belongs to this skill", () => {
    it("rolls skill A back to another skill's sha from A's own directory there", async () => {
      const runner = await makeRunner();
      // Register skill A.
      const aSha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/alpha",
        manifest: ECHO_MANIFEST.replace("name: echo", "name: alpha"),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/alpha", origin: OWNER });

      // Register skill B (separate name, different sha).
      const bSha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/beta",
        manifest: ECHO_MANIFEST.replace("name: echo", "name: beta"),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/beta", origin: OWNER });

      // B's sha holds A's files in skills/alpha/, as A's deploy left them:
      // rolling A back to it reads those, never B's code.
      const result = await runner.rollback({ name: "alpha", toGitSha: bSha, origin: OWNER });
      assertStatus(result, "no_op");

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
      const reg = await runner.register({ branch: "skill/shapeshift-v1", origin: OWNER });
      assertStatus(reg, "pending_approval");
      await runner.approveDeploy({ pendingId: reg.deployId, origin: OWNER });

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
      const reg2 = await runner.register({ branch: "skill/shapeshift-v2", origin: OWNER });
      assertStatus(reg2, "pending_approval");
      const approved = await runner.approveDeploy({ pendingId: reg2.deployId, origin: OWNER });
      assertStatus(approved, "live");

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
      await runner.register({ branch: "skill/shape-v1", origin: OWNER });

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
      await runner.register({ branch: "skill/shape-v2", origin: OWNER });

      const result = await runner.rollback({ name: "shape", toGitSha: v1Sha, origin: OWNER });
      assertStatus(result, "live");

      const skill = await tx((trx) => store.getSkillByName(trx, "shape"));
      expect(skill?.gitSha).toBe(result.gitSha);
      // inputs match v1's schema (x: integer), not v2's (different: string).
      expect(skill?.inputs).toMatchObject({
        properties: { x: { type: "integer" } },
      });
    });
  });

  describe("schemas from the skill's models", () => {
    /** A wasm skill whose frontmatter declares no schemas: its models carry them. */
    const MODEL_MANIFEST = `---
name: weather
description: a wasm skill whose models describe its schemas
tier: wasm
---
`;
    const CITY_INPUTS: SkillInputs = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      title: "Input",
    };
    const TEMP_OUTPUTS = {
      type: "object",
      properties: { tempC: { type: "number" } },
      title: "Output",
    };

    /** A runner whose schema importer answers `answers` in turn, then the last again. */
    async function runnerImporting(
      ...answers: Awaited<ReturnType<WasmSchemaImporter["importSchemas"]>>[]
    ) {
      const offline = offlineWasm(repo.bare);
      const schemaImporter = mock<WasmSchemaImporter>();
      for (const answer of answers) schemaImporter.importSchemas.mockResolvedValueOnce(answer);
      schemaImporter.importSchemas.mockResolvedValue(expectDefined(answers.at(-1), "an answer"));
      const runner = await makeRunner({
        ...offline,
        wasm: { ...offline.wasm, schemaImporter },
      });
      return { runner, schemaImporter };
    }

    async function pushWeather(branch: string, manifest: string): Promise<string> {
      return pushFeatureBranch({ work: repo.work, branch, manifest, body: ECHO_BODY });
    }

    it("puts the imported schemas live, records them on the deploy, and validates invokes against them", async () => {
      const { runner, schemaImporter } = await runnerImporting(
        ok({ inputs: CITY_INPUTS, outputs: TEMP_OUTPUTS }),
      );
      await pushWeather("skill/weather", MODEL_MANIFEST);

      const result = await runner.register({ branch: "skill/weather", origin: OWNER });

      assertStatus(result, "live");
      const skill = await tx((trx) => store.getSkillByName(trx, "weather"));
      expect(skill?.inputs).toEqual(CITY_INPUTS);
      expect(skill?.outputs).toEqual(TEMP_OUTPUTS);
      const deploy = await tx((trx) => store.getDeployById(trx, result.deployId));
      expect(deploy?.schemas).toEqual({ inputs: CITY_INPUTS, outputs: TEMP_OUTPUTS });
      expect((await runner.listToolDefs())[0]?.inputs).toEqual(CITY_INPUTS);
      const rejected = await runner.invoke({
        name: "weather",
        inputs: { days: 3 },
        runAs: await seededRunAs(),
      });
      expect(rejected._unsafeUnwrapErr()).toMatchObject({ kind: "invalid_inputs" });
      // The import runs the body under a run's memory cap and its wall clock
      // after the child's start.
      expect(schemaImporter.importSchemas).toHaveBeenCalledWith(
        expect.objectContaining({
          body: ECHO_BODY,
          packages: { builtins: [], wheelDir: null },
          memoryMb: 128,
          timeoutMs: 60_000 + 30_000,
        }),
      );
    });

    it("imports the skill in a real child: a body that does not import is rejected", async () => {
      // The runner's own importer: a real wasm child, offline, with no packages.
      const { schemaImporter: _stub, ...wasm } = offlineWasm(repo.bare).wasm;
      const runner = await makeRunner({ wasm });
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-broken",
        manifest: ECHO_MANIFEST,
        body: `1 / 0\n${ECHO_BODY}`,
      });
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });

      const broken = await runner.register({ branch: "skill/echo-broken", origin: OWNER });
      const live = await runner.register({ branch: "skill/echo", origin: OWNER });

      assertStatus(broken, "rejected");
      expect(broken.errors).toEqual([
        expect.stringMatching(
          /^schema_import_failed: skill\.py did not load: [\s\S]*ZeroDivisionError/,
        ),
      ]);
      // A body with no models keeps its frontmatter's schemas.
      assertStatus(live, "live");
      expect((await tx((trx) => store.getSkillByName(trx, "echo")))?.inputs).toMatchObject({
        required: ["x"],
      });
    });

    it("takes the frontmatter's inputs for a skill with no Input model, and the Output model's outputs", async () => {
      const { runner } = await runnerImporting(ok({ inputs: null, outputs: TEMP_OUTPUTS }));
      const manifest = MODEL_MANIFEST.replace(
        "tier: wasm\n",
        "tier: wasm\ninputs:\n  type: object\n  properties:\n    x:\n      type: integer\n",
      );
      await pushWeather("skill/weather", manifest);

      const result = await runner.register({ branch: "skill/weather", origin: OWNER });

      assertStatus(result, "live");
      const skill = await tx((trx) => store.getSkillByName(trx, "weather"));
      expect(skill?.inputs).toEqual({ type: "object", properties: { x: { type: "integer" } } });
      expect(skill?.outputs).toEqual(TEMP_OUTPUTS);
    });

    it("rejects a schema both a model and the frontmatter declare, and inputs neither does", async () => {
      const { runner } = await runnerImporting(
        ok({ inputs: CITY_INPUTS, outputs: TEMP_OUTPUTS }),
        ok({ inputs: null, outputs: null }),
      );
      await pushWeather(
        "skill/weather-twice",
        ECHO_MANIFEST.replace("name: echo", "name: weather"),
      );

      const twice = await runner.register({ branch: "skill/weather-twice", origin: OWNER });

      assertStatus(twice, "rejected");
      expect(twice.errors).toEqual([
        "inputs_declared_twice: skill.py defines an Input model; remove inputs from SKILL.md",
        "outputs_declared_twice: skill.py defines an Output model; remove outputs from SKILL.md",
      ]);
      await pushWeather("skill/weather-none", MODEL_MANIFEST);
      const none = await runner.register({ branch: "skill/weather-none", origin: OWNER });
      assertStatus(none, "rejected");
      expect(none.errors).toEqual([
        "missing_inputs: define an Input model in skill.py or inputs in SKILL.md",
      ]);
      expect(await tx((trx) => store.getSkillByName(trx, "weather"))).toBeUndefined();
    });

    it.each([
      {
        answer: { kind: "refused", message: "skill.py did not load: ZeroDivisionError" },
        error: "schema_import_failed: skill.py did not load: ZeroDivisionError",
      },
      {
        answer: { kind: "unavailable", message: "worker init failed: boom" },
        error: "schema_import_unavailable: worker init failed: boom; retry the register",
      },
    ] satisfies { answer: SchemaImportError; error: string }[])(
      "rejects an import that is $answer.kind, and commits nothing",
      async ({ answer, error }) => {
        const { runner } = await runnerImporting(err(answer));
        await pushWeather("skill/weather", MODEL_MANIFEST);
        const mainBefore = await getMainSha(repo.bare);

        const result = await runner.register({ branch: "skill/weather", origin: OWNER });

        assertStatus(result, "rejected");
        expect(result.errors).toEqual([error]);
        expect(await tx((trx) => store.getSkillByName(trx, "weather"))).toBeUndefined();
        expect(await getMainSha(repo.bare)).toBe(mainBefore);
      },
    );

    it("rejects an imported schema ajv cannot compile before main moves", async () => {
      const { runner } = await runnerImporting(
        ok({ inputs: { type: "object", properties: { city: { type: "place" } } }, outputs: null }),
      );
      await pushWeather("skill/weather", MODEL_MANIFEST);
      const mainBefore = await getMainSha(repo.bare);

      const result = await runner.register({ branch: "skill/weather", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors).toEqual([expect.stringMatching(/^invalid_inputs_schema: /)]);
      expect(await getMainSha(repo.bare)).toBe(mainBefore);
    });

    const CONTAINER_MANIFEST = MODEL_MANIFEST.replace("tier: wasm", "tier: container");
    const IDNA_LOCK = "idna==3.10 --hash=sha256:00\n";

    /** A runner whose container importer answers `answer`, with the shared venv volume or without. */
    async function runnerImportingContainer(
      answer: Awaited<ReturnType<ContainerSchemaImporter["importSchemas"]>>,
      depsCacheVolumeName: string | undefined,
    ) {
      const containerSchemaImporter = mock<ContainerSchemaImporter>();
      containerSchemaImporter.importSchemas.mockResolvedValue(answer);
      const runner = await makeRunner({
        containerSchemaImporter,
        ...(depsCacheVolumeName !== undefined && { depsCacheVolumeName }),
      });
      return { runner, containerSchemaImporter };
    }

    /** A container skill on `skill/weather` whose models carry its schemas, declaring idna and its lockfile. */
    async function pushContainerWithDeps(): Promise<void> {
      const branch = "skill/weather";
      await writeFile(
        skillFile(repo.work, "SKILL.md", "weather"),
        CONTAINER_MANIFEST.replace(
          "tier: container\n",
          "tier: container\ndependencies:\n  - idna==3.10\n",
        ),
      );
      await writeFile(skillFile(repo.work, "skill.py", "weather"), ECHO_BODY);
      await writeFile(skillFile(repo.work, "requirements.lock", "weather"), IDNA_LOCK);
      await execFileP("git", ["-C", repo.work, "add", "."]);
      await execFileP("git", ["-C", repo.work, "commit", "-m", branch, "--allow-empty"]);
      await execFileP("git", [
        "-C",
        repo.work,
        "push",
        "-f",
        "origin",
        `HEAD:refs/heads/${branch}`,
      ]);
    }

    it("imports a container skill under its own resources and wall clock", async () => {
      const { runner, containerSchemaImporter } = await runnerImportingContainer(
        ok({ inputs: CITY_INPUTS, outputs: TEMP_OUTPUTS }),
        undefined,
      );
      await pushWeather(
        "skill/weather",
        CONTAINER_MANIFEST.replace(
          "tier: container\n",
          "tier: container\nresources:\n  memory_mb: 256\n  wall_clock_s: 90\n",
        ),
      );

      const result = await runner.register({ branch: "skill/weather", origin: OWNER });

      assertStatus(result, "pending_approval");
      const deploy = await tx((trx) => store.getDeployById(trx, result.deployId));
      expect(deploy?.schemas).toEqual({ inputs: CITY_INPUTS, outputs: TEMP_OUTPUTS });
      expect(containerSchemaImporter.importSchemas).toHaveBeenCalledWith({
        body: ECHO_BODY,
        lockfile: null,
        resourceLimits: { memory_bytes: 256 * 1024 * 1024 },
        timeoutMs: 90_000,
      });
    });

    it("imports a container skill's dependencies through the shared venv volume", async () => {
      const { runner, containerSchemaImporter } = await runnerImportingContainer(
        ok({ inputs: CITY_INPUTS, outputs: null }),
        "cogmo-skills-venvs",
      );
      await pushContainerWithDeps();

      const result = await runner.register({ branch: "skill/weather", origin: OWNER });

      assertStatus(result, "pending_approval");
      expect(containerSchemaImporter.importSchemas).toHaveBeenCalledWith(
        expect.objectContaining({
          lockfile: { hash: hashLockfileContents(IDNA_LOCK), contents: IDNA_LOCK },
        }),
      );
    });

    it("keeps a container skill with dependencies on its frontmatter without the shared venv volume", async () => {
      const { runner, containerSchemaImporter } = await runnerImportingContainer(
        ok({ inputs: CITY_INPUTS, outputs: null }),
        undefined,
      );
      await pushContainerWithDeps();

      const result = await runner.register({ branch: "skill/weather", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors).toEqual([
        "missing_inputs: SKILL.md declares no inputs, and this deployment cannot import the skill's models",
      ]);
      expect(containerSchemaImporter.importSchemas).not.toHaveBeenCalled();
    });

    it("rejects a container import that is refused", async () => {
      const { runner } = await runnerImportingContainer(
        err({ kind: "refused", message: "skill.py did not load: ZeroDivisionError" }),
        undefined,
      );
      await pushWeather("skill/weather", CONTAINER_MANIFEST);

      const result = await runner.register({ branch: "skill/weather", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors).toEqual([
        "schema_import_failed: skill.py did not load: ZeroDivisionError",
      ]);
    });

    it.each([
      { noNetworkSessions: false, imports: false },
      { noNetworkSessions: true, imports: true },
    ])(
      "a sandbox whose backend has noNetworkSessions $noNetworkSessions imports container skills: $imports",
      async ({ noNetworkSessions, imports }) => {
        const sandbox = mock<SandboxClient>({
          capabilities: {
            siblingContainers: "host-proxy",
            hostBindMount: true,
            customImage: true,
            volumes: "docker",
            workingTreeTransport: "bind-mount",
            depsCacheSharing: "shared-volume",
            noNetworkSessions,
          },
        });
        sandbox.ensureImagePresent.mockResolvedValue();
        sandbox.create.mockRejectedValue(new Error("no daemon in this test"));
        const runner = await makeRunner({ sandbox });
        await pushWeather("skill/weather", CONTAINER_MANIFEST);

        const result = await runner.register({ branch: "skill/weather", origin: OWNER });

        assertStatus(result, "rejected");
        expect(result.errors).toEqual([
          imports
            ? "schema_import_unavailable: schema-import session did not start: no daemon in this test; retry the register"
            : "missing_inputs: SKILL.md declares no inputs, and this deployment cannot import the skill's models",
        ]);
        expect(sandbox.create).toHaveBeenCalledTimes(imports ? 1 : 0);
        if (imports)
          expect(sandbox.create).toHaveBeenCalledWith(expect.objectContaining({ network: "none" }));
      },
    );

    it("keeps a container skill on its frontmatter where the deployment cannot import it", async () => {
      const { runner, schemaImporter } = await runnerImporting(
        ok({ inputs: CITY_INPUTS, outputs: null }),
      );
      await pushWeather("skill/weather", CONTAINER_MANIFEST);

      const result = await runner.register({ branch: "skill/weather", origin: OWNER });

      assertStatus(result, "rejected");
      expect(result.errors).toEqual([
        "missing_inputs: SKILL.md declares no inputs, and this deployment cannot import the skill's models",
      ]);
      expect(schemaImporter.importSchemas).not.toHaveBeenCalled();
    });

    it("approve puts live the schemas register recorded, importing nothing", async () => {
      const { runner, schemaImporter } = await runnerImporting(
        ok({ inputs: CITY_INPUTS, outputs: null }),
      );
      await pushWeather(
        "skill/weather",
        MODEL_MANIFEST.replace("tier: wasm\n", "tier: wasm\neffects:\n  - sends_message\n"),
      );
      const pending = await runner.register({ branch: "skill/weather", origin: OWNER });
      assertStatus(pending, "pending_approval");
      schemaImporter.importSchemas.mockClear();

      const approved = await runner.approveDeploy({ pendingId: pending.deployId, origin: OWNER });

      assertStatus(approved, "live");
      expect((await tx((trx) => store.getSkillByName(trx, "weather")))?.inputs).toEqual(
        CITY_INPUTS,
      );
      expect(schemaImporter.importSchemas).not.toHaveBeenCalled();
    });

    it("approve of a pending deploy that recorded no schemas puts its frontmatter's live", async () => {
      const { runner } = await runnerImporting(ok({ inputs: null, outputs: null }));
      await pushWeather(
        "skill/weather",
        ECHO_MANIFEST.replace("name: echo", "name: weather").replace(
          "tier: wasm\n",
          "tier: wasm\neffects:\n  - sends_message\n",
        ),
      );
      const pending = await runner.register({ branch: "skill/weather", origin: OWNER });
      assertStatus(pending, "pending_approval");
      // A row from before the column.
      await db.execute(sql`UPDATE skill_deploys SET schemas = NULL WHERE id = ${pending.deployId}`);

      const approved = await runner.approveDeploy({ pendingId: pending.deployId, origin: OWNER });

      assertStatus(approved, "live");
      expect((await tx((trx) => store.getSkillByName(trx, "weather")))?.inputs).toMatchObject({
        properties: { x: { type: "integer" } },
      });
    });

    it("rollback restores the schemas the target went live with, importing nothing", async () => {
      const { runner, schemaImporter } = await runnerImporting(
        ok({ inputs: CITY_INPUTS, outputs: TEMP_OUTPUTS }),
        ok({ inputs: { type: "object", properties: { zip: { type: "string" } } }, outputs: null }),
      );
      const v1 = await pushWeather("skill/weather-v1", MODEL_MANIFEST);
      assertStatus(await runner.register({ branch: "skill/weather-v1", origin: OWNER }), "live");
      await pushWeather("skill/weather-v2", MODEL_MANIFEST.replace("whose", "v2, whose"));
      assertStatus(await runner.register({ branch: "skill/weather-v2", origin: OWNER }), "live");
      schemaImporter.importSchemas.mockClear();

      const rolled = await runner.rollback({ name: "weather", toGitSha: v1, origin: OWNER });

      assertStatus(rolled, "live");
      const skill = await tx((trx) => store.getSkillByName(trx, "weather"));
      expect(skill).toMatchObject({
        gitSha: rolled.gitSha,
        inputs: CITY_INPUTS,
        outputs: TEMP_OUTPUTS,
      });
      const deploy = await tx((trx) => store.getDeployById(trx, rolled.deployId));
      expect(deploy?.schemas).toEqual({ inputs: CITY_INPUTS, outputs: TEMP_OUTPUTS });
      expect(schemaImporter.importSchemas).not.toHaveBeenCalled();
    });

    it("rollback to a deploy that recorded no schemas puts its frontmatter's live", async () => {
      const { runner } = await runnerImporting(
        ok({ inputs: null, outputs: null }),
        ok({ inputs: CITY_INPUTS, outputs: null }),
      );
      const v1 = await pushWeather(
        "skill/weather-v1",
        ECHO_MANIFEST.replace("name: echo", "name: weather"),
      );
      assertStatus(await runner.register({ branch: "skill/weather-v1", origin: OWNER }), "live");
      await db.execute(sql`UPDATE skill_deploys SET schemas = NULL WHERE git_sha = ${v1}`);
      await pushWeather("skill/weather-v2", MODEL_MANIFEST);
      assertStatus(await runner.register({ branch: "skill/weather-v2", origin: OWNER }), "live");

      const rolled = await runner.rollback({ name: "weather", toGitSha: v1, origin: OWNER });

      assertStatus(rolled, "live");
      expect((await tx((trx) => store.getSkillByName(trx, "weather")))?.inputs).toMatchObject({
        properties: { x: { type: "integer" } },
      });
    });

    it("rejects a rollback to a sha that never went live and declares no inputs", async () => {
      const { runner } = await runnerImporting(ok({ inputs: CITY_INPUTS, outputs: null }));
      await pushWeather("skill/weather-v1", MODEL_MANIFEST);
      assertStatus(await runner.register({ branch: "skill/weather-v1", origin: OWNER }), "live");
      // Committed on main's line but never registered.
      const unregistered = await pushWeather(
        "skill/weather-draft",
        MODEL_MANIFEST.replace("whose", "draft, whose"),
      );

      const rolled = await runner.rollback({
        name: "weather",
        toGitSha: unregistered,
        origin: OWNER,
      });

      assertStatus(rolled, "rejected");
      expect(rolled.errors).toEqual([
        "schemas_unknown: no deploy of the target sha recorded its schemas, and its SKILL.md declares no inputs",
      ]);
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
      const reg = await runner.register({ branch: "skill/notify-skill", origin: OWNER });
      assertStatus(reg, "pending_approval");
      expect(reg.gitSha).toBe(sha);
      if (!reg.deployId) throw new Error("expected pendingId");

      // After insert: skill row exists but disabled=true (first-time
      // pending_approval — there's no prior live version to keep visible).
      const beforeDeny = await tx((trx) => store.getSkillByName(trx, "notify-skill"));
      expect(beforeDeny?.disabled).toBe(true);
      expect(beforeDeny?.gitSha).toBe(sha);

      expect(await runner.denyDeploy({ pendingId: reg.deployId, reason: "not now" })).toEqual(
        ok(undefined),
      );

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
      const reg2 = await runner.register({ branch: "skill/notify-skill", origin: OWNER });
      assertStatus(reg2, "pending_approval");
      expect(reg2.gitSha).toBe(sha);
      expect(reg2.deployId).toBeTruthy();
      expect(reg2.deployId).not.toBe(reg.deployId);
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
      const reg1 = await runner.register({ branch: "skill/upgradable-v1", origin: OWNER });
      assertStatus(reg1, "live");

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
      const reg2 = await runner.register({ branch: "skill/upgradable-v2", origin: OWNER });
      assertStatus(reg2, "pending_approval");
      if (!reg2.deployId) throw new Error("expected pendingId for v2");

      // Critical: skills row UNCHANGED — still pointing at v1, still live.
      const duringApproval = await tx((trx) => store.getSkillByName(trx, "upgradable"));
      expect(duringApproval?.disabled).toBe(false);
      expect(duringApproval?.gitSha).toBe(v1Sha);

      // Deny the v2 upgrade. The live v1 should still be live afterwards —
      // this is the exact regression the row-untouched rule prevents.
      await runner.denyDeploy({ pendingId: reg2.deployId, reason: "rejected" });
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
            scheduleNextRunAt: null,
            runAs: DEFAULT_RUN_AS,
            branchTipSha: "0000000000000000000000000000000000000abc",
            lockfileHash: null,
            inputs: { type: "object", properties: {} },
            outputs: null,
            classifierLog: {
              classifier_version: "test",
              risk_tier: "notify",
              declared_effects: [],
              detected_effects: [],
              declared_secrets: [],
              declared_dependencies: [],
              validation_errors: [],
              reasons: [],
              declared_network: null,
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

  describe("remote mirror after register / approve / rollback", () => {
    /**
     * Standard skills setup + a second bare repo acting as the configured
     * remote. After register/approve/rollback, the remote's main should
     * equal the skills bare repo's main — without this the Daytona-backed
     * coding flow would clone a stale skill set.
     */
    async function setupRepoWithRemote(): Promise<RepoSetup & { remote: string }> {
      let remote = "";
      const base = await setupRepo({
        beforeLayout: async (bare) => {
          // Stand-in for the GitHub/Gitea URL Cogmo would attach as origin
          // in production. Built via the shared bare-repo fixture so the
          // seed shape stays consistent with configure-remote.test.ts.
          ({ path: remote } = await makePopulatedBareRepo(
            join(bare, ".."),
            "skills-remote",
            "skills-remote.git",
          ));
          // Attach the remote as `origin` and fetch its main, as
          // configureSkillsRemote does at wizard time, before the boot
          // whose layout commit goes on top of it.
          await execFileP("git", ["-C", bare, "remote", "add", "origin", remote]);
          await execFileP("git", ["-C", bare, "fetch", remote, "+refs/heads/main:refs/heads/main"]);
        },
      });
      // The layout commit reaches the remote with the first deploy's push.
      return { ...base, remote };
    }

    it("pushes new main SHA to remote after a successful register", async () => {
      const repoWithRemote = await setupRepoWithRemote();
      try {
        const runner = await SkillRunnerImpl.create({
          store,
          runInTx: tx,
          secretsStore: makeMockSecrets(),
          userTimezone: "UTC",
          defaultRunAs: DEFAULT_RUN_AS,
          skillsRepoPath: repoWithRemote.bare,
          ...offlineWasm(repoWithRemote.bare),
        });

        const sha = await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/echo",
          manifest: ECHO_MANIFEST,
          body: ECHO_BODY,
        });

        const result = await runner.register({ branch: "skill/echo", origin: OWNER });
        assertStatus(result, "live");
        expect(result.gitSha).toBe(sha);

        // The crux: remote main now equals the registered SHA. Without the
        // mirror push, this would still be the seed commit.
        const remoteMain = (
          await execFileP("git", ["-C", repoWithRemote.remote, "rev-parse", "refs/heads/main"])
        ).stdout.trim();
        expect(remoteMain).toBe(sha);
      } finally {
        await repoWithRemote.cleanup();
      }
    });

    it("register still reports live even if the remote push fails", async () => {
      // Setup the remote, then point origin at a non-existent path so the
      // push fails. Register should still complete — local is the truth.
      const repoWithRemote = await setupRepoWithRemote();
      await execFileP("git", [
        "-C",
        repoWithRemote.bare,
        "remote",
        "set-url",
        "origin",
        join(repoWithRemote.bare, "..", "does-not-exist.git"),
      ]);

      try {
        const runner = await makeRunnerForRepo(repoWithRemote.bare);

        const sha = await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/echo",
          manifest: ECHO_MANIFEST,
          body: ECHO_BODY,
        });

        const result = await runner.register({ branch: "skill/echo", origin: OWNER });
        assertStatus(result, "live");
        expect(result.gitSha).toBe(sha);
        // Local main advanced even though remote push failed.
        expect(await getMainSha(repoWithRemote.bare)).toBe(sha);
      } finally {
        await repoWithRemote.cleanup();
      }
    });

    it("an abort after the commit returns promptly from a stalled mirror push and still reports live", async () => {
      const repoWithRemote = await setupRepoWithRemote();
      try {
        // The remote's pre-receive hook marks that the push arrived, then stalls it.
        const pushing = join(repoWithRemote.remote, "..", "pushing");
        const hook = join(repoWithRemote.remote, "hooks", "pre-receive");
        await writeFile(hook, `#!/bin/sh\ntouch '${pushing}'\nsleep 20\n`);
        await chmod(hook, 0o755);
        const runner = await makeRunnerForRepo(repoWithRemote.bare);
        const sha = await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/echo",
          manifest: ECHO_MANIFEST,
          body: ECHO_BODY,
        });
        const controller = new AbortController();

        const registered = runner.register({
          branch: "skill/echo",
          origin: OWNER,
          signal: controller.signal,
        });
        while (!existsSync(pushing)) await new Promise((r) => setTimeout(r, 20));
        const abortedAt = Date.now();
        controller.abort(new Error("register deadline"));
        const result = await registered;

        expect(Date.now() - abortedAt).toBeLessThan(5_000);
        assertStatus(result, "live");
        expect(result.gitSha).toBe(sha);
        expect(await getMainSha(repoWithRemote.bare)).toBe(sha);
      } finally {
        await repoWithRemote.cleanup();
      }
    });

    it("a stalled HTTPS mirror push gives up at its own timeout and still reports live", async () => {
      const repoWithRemote = await setupRepoWithRemote();
      // An HTTPS remote that takes the connection and never answers, so the
      // push goes through the PAT branch and stalls in the TLS handshake.
      const sockets = new Set<Socket>();
      const connected = Promise.withResolvers<void>();
      const server = createServer((socket) => {
        sockets.add(socket);
        connected.resolve();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no TCP address");
      await execFileP("git", [
        "-C",
        repoWithRemote.bare,
        "remote",
        "set-url",
        "origin",
        `https://127.0.0.1:${address.port}/owner/skills.git`,
      ]);
      const secretsStore = mock<SecretsStore>();
      secretsStore.getSecret.mockResolvedValue(
        JSON.stringify(
          GitHubIdentitySchema.parse({
            pat: "ghp_test",
            sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
            sshPublicKey: "ssh-ed25519 AAAA",
            login: "cogmo-bot",
            id: "12345",
          }),
        ),
      );
      const pushDeadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(pushDeadline.signal);
      try {
        const runner = await SkillRunnerImpl.create({
          store,
          runInTx: tx,
          secretsStore,
          userTimezone: "UTC",
          defaultRunAs: DEFAULT_RUN_AS,
          skillsRepoPath: repoWithRemote.bare,
          ...offlineWasm(repoWithRemote.bare),
        });
        const sha = await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/echo",
          manifest: ECHO_MANIFEST,
          body: ECHO_BODY,
        });

        // No caller signal, as from the CLI.
        const registered = runner.register({ branch: "skill/echo", origin: OWNER });
        await connected.promise;
        pushDeadline.abort(new DOMException("push timed out", "TimeoutError"));
        const result = await registered;

        expect(timeout).toHaveBeenCalledWith(60_000);
        assertStatus(result, "live");
        expect(result.gitSha).toBe(sha);
        expect(await getMainSha(repoWithRemote.bare)).toBe(sha);
      } finally {
        timeout.mockRestore();
        for (const socket of sockets) socket.destroy();
        server.close();
        await repoWithRemote.cleanup();
      }
    });

    /**
     * Manifest that classifies into the `approve` tier — `sends_message`
     * is destructive enough that register lands as `pending_approval`,
     * not `live`. The classifier sees the declared effect and routes here
     * without needing the body to actually call any messaging API.
     */
    const APPROVE_MANIFEST = `---
name: notifier
description: sends user notifications
tier: wasm
inputs:
  type: object
  properties: {}
effects:
  - sends_message
---
`;

    it("approveDeploy pushes the approved SHA to remote", async () => {
      const repoWithRemote = await setupRepoWithRemote();
      try {
        const runner = await makeRunnerForRepo(repoWithRemote.bare);
        const sha = await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/notifier",
          manifest: APPROVE_MANIFEST,
          body: ECHO_BODY,
        });

        // Register lands as pending_approval (sends_message → approve tier)
        // and leaves both local and remote main on the seed commit.
        const reg = await runner.register({ branch: "skill/notifier", origin: OWNER });
        assertStatus(reg, "pending_approval");
        const pendingId = reg.deployId;
        if (!pendingId) throw new Error("expected pendingId");
        const seedSha = (
          await execFileP("git", ["-C", repoWithRemote.remote, "rev-parse", "refs/heads/main"])
        ).stdout.trim();

        // Approve. Local main should advance to the deploy sha AND the
        // remote should follow — the regression case is "approve advances
        // local but leaves remote on the seed commit", which would silently
        // break Daytona-backed coding tasks operating on the skill.
        const approved = await runner.approveDeploy({ pendingId, origin: OWNER });
        assertStatus(approved, "live");
        expect(approved.gitSha).toBe(sha);

        const remoteMainAfter = (
          await execFileP("git", ["-C", repoWithRemote.remote, "rev-parse", "refs/heads/main"])
        ).stdout.trim();
        expect(remoteMainAfter).toBe(sha);
        expect(remoteMainAfter).not.toBe(seedSha);
      } finally {
        await repoWithRemote.cleanup();
      }
    });

    it("rollback pushes the restoring commit to the remote", async () => {
      const repoWithRemote = await setupRepoWithRemote();
      try {
        const runner = await makeRunnerForRepo(repoWithRemote.bare);

        // v1 → register, advances local + remote main.
        const v1 = await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/echo-v1",
          manifest: ECHO_MANIFEST,
          body: ECHO_BODY,
        });
        await runner.register({ branch: "skill/echo-v1", origin: OWNER });
        // v2 → register again, advances further.
        const updatedManifest = ECHO_MANIFEST.replace(
          "a wasm skill that echoes one int field",
          "v2 description",
        );
        const v2 = await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/echo-v2",
          manifest: updatedManifest,
          body: ECHO_BODY,
        });
        await runner.register({ branch: "skill/echo-v2", origin: OWNER });

        // Sanity: remote main is at v2 before rollback.
        expect(
          (
            await execFileP("git", ["-C", repoWithRemote.remote, "rev-parse", "refs/heads/main"])
          ).stdout.trim(),
        ).toBe(v2);

        // Rollback to v1 — a restoring commit fast-forwards local main, and
        // a plain push takes the remote with it.
        const result = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });
        assertStatus(result, "live");

        expect(await getMainSha(repoWithRemote.bare)).toBe(result.gitSha);
        expect(
          (
            await execFileP("git", ["-C", repoWithRemote.remote, "rev-parse", "refs/heads/main"])
          ).stdout.trim(),
        ).toBe(result.gitSha);
      } finally {
        await repoWithRemote.cleanup();
      }
    });

    it("a recovered rollback pushes main to the remote", async () => {
      const repoWithRemote = await setupRepoWithRemote();
      try {
        const runner = await makeRunnerForRepo(repoWithRemote.bare);
        const v1 = await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/echo-v1",
          manifest: ECHO_MANIFEST,
          body: ECHO_BODY,
        });
        await runner.register({ branch: "skill/echo-v1", origin: OWNER });
        await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/echo-v2",
          manifest: ECHO_MANIFEST.replace("echoes one int field", "v2"),
          body: ECHO_BODY,
        });
        await runner.register({ branch: "skill/echo-v2", origin: OWNER });
        const real = DrizzleSkillStore.prototype.executeRollback.bind(store);
        vi.spyOn(store, "executeRollback").mockImplementationOnce(async (trx, params) => {
          await real(trx, params);
          throw new Error("commit failed");
        });
        await expect(
          runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER }),
        ).rejects.toThrow("commit failed");

        const repeat = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });

        assertStatus(repeat, "live");
        expect(
          (
            await execFileP("git", ["-C", repoWithRemote.remote, "rev-parse", "refs/heads/main"])
          ).stdout.trim(),
        ).toBe(repeat.gitSha);
      } finally {
        await repoWithRemote.cleanup();
      }
    });

    it("rollback's push refuses to overwrite a divergent remote", async () => {
      // After register but before rollback, manually move remote main to a
      // sha unrelated to local main. The push should fail; remote main
      // stays put; local rollback still succeeds (local is authoritative
      // per the design contract).
      const repoWithRemote = await setupRepoWithRemote();
      try {
        const runner = await makeRunnerForRepo(repoWithRemote.bare);

        const v1 = await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/echo-v1",
          manifest: ECHO_MANIFEST,
          body: ECHO_BODY,
        });
        await runner.register({ branch: "skill/echo-v1", origin: OWNER });
        // Advance main past v1. SHA isn't asserted here — what matters
        // is that the second register sets up the rollback target. The
        // post-rollback divergence push uses `divergent` below, not v2.
        await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/echo-v2",
          manifest: ECHO_MANIFEST.replace(
            "a wasm skill that echoes one int field",
            "v2 description",
          ),
          body: ECHO_BODY,
        });
        await runner.register({ branch: "skill/echo-v2", origin: OWNER });

        // Out-of-band: someone (a bad actor, a misconfigured CI, an
        // operator running raw git) advances remote main to a divergent
        // sha. Push from the work clone with `+` to force.
        const divergent = await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "rogue",
          manifest: ECHO_MANIFEST.replace("a wasm skill that echoes one int field", "divergent"),
          body: ECHO_BODY,
        });
        await execFileP("git", [
          "-C",
          repoWithRemote.work,
          "push",
          "-f",
          repoWithRemote.remote,
          `${divergent}:refs/heads/main`,
        ]);

        // Now rollback. Local main fast-forwards to the restoring commit;
        // the plain push is rejected, since the remote's main is not its
        // ancestor. The mirror is non-blocking, so rollback still reports
        // `live`.
        const result = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });
        assertStatus(result, "live");

        // Local rolled forward as expected.
        expect(await getMainSha(repoWithRemote.bare)).toBe(result.gitSha);
        // Remote retained the divergent sha — the push refused to overwrite it.
        expect(
          (
            await execFileP("git", ["-C", repoWithRemote.remote, "rev-parse", "refs/heads/main"])
          ).stdout.trim(),
        ).toBe(divergent);
        // Sanity: divergent is not v1 — otherwise this test would trivially
        // pass.
        expect(divergent).not.toBe(v1);
      } finally {
        await repoWithRemote.cleanup();
      }
    });

    /** Construct a runner against an arbitrary skills bare repo. Extracted
     * because the three new tests above all need it with the same mock
     * memory / files / secrets setup. */
    async function makeRunnerForRepo(skillsRepoPath: string): Promise<SkillRunnerImpl> {
      return SkillRunnerImpl.create({
        store,
        runInTx: tx,
        secretsStore: makeMockSecrets(),
        userTimezone: "UTC",
        defaultRunAs: DEFAULT_RUN_AS,
        skillsRepoPath,
        ...offlineWasm(skillsRepoPath),
      });
    }
  });
});
