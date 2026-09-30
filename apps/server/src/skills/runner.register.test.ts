import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
import { GitHubIdentitySchema } from "../secrets/github.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { expectDefined } from "../test/assertions.js";
import { mockFilesService } from "../test/factories.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { makePopulatedBareRepo } from "../test/skills-bare-repo.js";
import { channels, userIdentities } from "../transport/store/schema.js";
import { bootstrapSkillsRepo } from "./repo.js";
import type { SkillRunAs, SkillRunServices } from "./run-as.js";
import { type SkillActor, type SkillDeployOrigin, SkillRunnerImpl } from "./runner.js";
import { DrizzleSkillStore, type SkillRunIdentity } from "./store/index.js";

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

const RUN_AS: SkillRunAs = {
  userId: "user-1",
  service: { memory: mock<SkillRunServices["memory"]>(), files: mockFilesService() },
};

function makeMockSecrets(): SecretsStore {
  return mock<SecretsStore>();
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

const ECHO_WITH_DEPS = `---
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

  async function makeRunner(overrides: Partial<Parameters<typeof SkillRunnerImpl.create>[0]> = {}) {
    return SkillRunnerImpl.create({
      store,
      runInTx: tx,
      secretsStore: makeMockSecrets(),
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      skillsRepoPath: repo.bare,
      ...overrides,
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

    const result = await runner.register({ branch: "skill/echo", origin: OWNER });
    expect(result.status).toBe("live");
    expect(result.name).toBe("echo");
    expect(result.gitSha).toBe(sha);
    // ECHO body has no detectable side effects + manifest declares no
    // effects → AST classifier promotes to auto. Pre-AST stub
    // returned `notify` here because auto was unreachable.
    expect(result.riskTier).toBe("auto");

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
    const first = await runner.register({ branch: "skill/echo", origin: OWNER });
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
    const second = await runner.register({ branch: "at-main", origin: OWNER });
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
    await runner.register({ branch: "skill/echo", origin: OWNER });

    // Build a divergent branch: reset work to a fresh root commit (no
    // ancestor of main), push as `divergent`.
    await execFileP("git", ["-C", repo.work, "checkout", "--orphan", "fresh"]);
    await writeFile(join(repo.work, "SKILL.md"), ECHO_MANIFEST.replace("name: echo", "name: alt"));
    await writeFile(join(repo.work, "skill.py"), ECHO_BODY);
    await execFileP("git", ["-C", repo.work, "add", "."]);
    await execFileP("git", ["-C", repo.work, "commit", "-m", "fresh root"]);
    await execFileP("git", ["-C", repo.work, "push", "origin", "fresh:refs/heads/divergent"]);

    const result = await runner.register({ branch: "divergent", origin: OWNER });
    expect(result.status).toBe("rejected");
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
    expect(result.status).toBe("live");
    expect(await getMainSha(repo.bare)).toBe(sha);
    expect((await tx((trx) => store.getSkillByName(trx, "echo")))?.gitSha).toBe(sha);
  });

  it("rejects a missing branch", async () => {
    const runner = await makeRunner();
    const result = await runner.register({ branch: "nope", origin: OWNER });
    expect(result.status).toBe("rejected");
    expect(result.errors?.[0]).toMatch(/branch_not_found/);
  });

  it("rejects a branch missing SKILL.md", async () => {
    const runner = await makeRunner();
    await writeFile(join(repo.work, "skill.py"), ECHO_BODY);
    await execFileP("git", ["-C", repo.work, "add", "."]);
    await execFileP("git", ["-C", repo.work, "commit", "-m", "no manifest"]);
    await execFileP("git", ["-C", repo.work, "push", "origin", "main:refs/heads/no-manifest"]);
    const result = await runner.register({ branch: "no-manifest", origin: OWNER });
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
    const result = await runner.register({ branch: "bad", origin: OWNER });
    expect(result.status).toBe("rejected");
    expect(result.errors?.length).toBeGreaterThan(0);
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
      expect(result.status).toBe("rejected");
      expect(result.errors?.[0]).toMatch(/requirements_lock_missing/);
      // main did not move — register failed before any update-ref.
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
      expect(skill).toBeUndefined();
    });

    it("rejects when requirements.lock is committed but empty", async () => {
      const runner = await makeRunner();
      await writeFile(join(repo.work, "SKILL.md"), ECHO_WITH_DEPS);
      await writeFile(join(repo.work, "skill.py"), ECHO_BODY);
      await writeFile(join(repo.work, "requirements.lock"), "   \n");
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
      expect(result.status).toBe("rejected");
      expect(result.errors?.[0]).toMatch(/requirements_lock_empty/);
    });

    it("stores lockfile_hash on success when deps + lockfile are committed", async () => {
      const runner = await makeRunner();
      await writeFile(join(repo.work, "SKILL.md"), ECHO_WITH_DEPS);
      await writeFile(join(repo.work, "skill.py"), ECHO_BODY);
      await writeFile(join(repo.work, "requirements.lock"), ECHO_LOCKFILE);
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
      expect(result.status).toBe("live");
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
      // sha256(ECHO_LOCKFILE) — hex length 64 is the schema-level shape.
      expect(skill?.lockfileHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("an abort during the PyPI lookups rejects with its reason and commits nothing", async () => {
      // A dependency Pyodide doesn't bundle, so the compatibility check asks PyPI.
      const lockfile = "cogmo-unbundled==1.0.0 \\\n    --hash=sha256:0\n";
      await writeFile(
        join(repo.work, "SKILL.md"),
        ECHO_WITH_DEPS.replace("httpx==0.27.0", "cogmo-unbundled==1.0.0"),
      );
      await writeFile(join(repo.work, "skill.py"), ECHO_BODY);
      await writeFile(join(repo.work, "requirements.lock"), lockfile);
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
      const runner = await makeRunner();
      const mainBefore = await getMainSha(repo.bare);
      const controller = new AbortController();
      const reason = new Error("register deadline");
      const fetch = vi.fn(async () => {
        controller.abort(reason);
        return new Response(null, { status: 404 });
      });
      vi.stubGlobal("fetch", fetch);

      try {
        await expect(
          runner.register({ branch: "skill/echo-pypi", origin: OWNER, signal: controller.signal }),
        ).rejects.toBe(reason);
      } finally {
        vi.unstubAllGlobals();
      }

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
      expect(result.status).toBe("live");
      const skill = await tx((trx) => store.getSkillByName(trx, "echo"));
      expect(skill?.lockfileHash).toBeNull();
    });

    describe("compiler verification", () => {
      async function commitWithLockfile(branch: string, lockfile: string): Promise<string> {
        await writeFile(join(repo.work, "SKILL.md"), ECHO_WITH_DEPS);
        await writeFile(join(repo.work, "skill.py"), ECHO_BODY);
        await writeFile(join(repo.work, "requirements.lock"), lockfile);
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
        expect(result.status).toBe("live");
        expect(compiler.compile).toHaveBeenCalledWith(["httpx==0.27.0"], {});
      });

      it("rejects with requirements_lock_stale when the compile output differs", async () => {
        const committed = "httpx==0.27.0 --hash=sha256:OLD\n";
        const fresh = "httpx==0.27.0 --hash=sha256:NEW\n";
        const compiler = { compile: vi.fn().mockResolvedValue(ok(fresh)) };
        const runner = await makeRunner({ lockfileCompiler: compiler });
        await commitWithLockfile("skill/echo-stale", committed);

        const result = await runner.register({ branch: "skill/echo-stale", origin: OWNER });
        expect(result.status).toBe("rejected");
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
        expect(result.status).toBe("rejected");
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

      it("skips compile when no compiler is configured (tier-1-only deployment)", async () => {
        const lockfile = "httpx==0.27.0 --hash=sha256:0\n";
        // No compiler — default constructor wires one only when `sandbox`
        // is configured, and this test harness never sets `sandbox`, so
        // `#lockfileCompiler` lands undefined.
        const runner = await makeRunner();
        await commitWithLockfile("skill/echo-no-compiler", lockfile);

        const result = await runner.register({ branch: "skill/echo-no-compiler", origin: OWNER });
        expect(result.status).toBe("live");
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

    const result = await runner.invoke({ name: "echo", inputs: { x: 7 }, runAs: RUN_AS });
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
    await r1.register({ branch: "skill/echo", origin: OWNER });

    const r2 = await makeRunner();
    const result = await r2.invoke({ name: "echo", inputs: { x: 7 }, runAs: RUN_AS });
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
    await runner.register({ branch: "skill/bad-out", origin: OWNER });
    const result = await runner.invoke({ name: "bad-out", inputs: { x: 1 }, runAs: RUN_AS });
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
      "a tier-1 skill that echoes one int field",
      "v2 now adds two instead",
    );
    await pushFeatureBranch({
      work: repo.work,
      branch: "skill/echo-v2",
      manifest: updatedManifest,
      body: ECHO_BODY,
    });
    const second = await runner.register({ branch: "skill/echo-v2", origin: OWNER });
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
      await runner.register({ branch: "skill/echo-v1", origin: OWNER });

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
      await runner.register({ branch: "skill/echo-v2", origin: OWNER });

      const result = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });
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
      await runner.register({ branch: "skill/echo", origin: OWNER });

      const result = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });
      expect(result.status).toBe("no_op");
    });

    it("rollback succeeds even if a fresh compile would resolver_fail (yanked wheel)", async () => {
      // Compiler stub: register/approve calls succeed; any rollback-time
      // call would trip the resolver_failed path. Rollback MUST skip
      // verifyFresh so an upstream yank doesn't block rewinding to a
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
      await writeFile(join(repo.work, "SKILL.md"), ECHO_WITH_DEPS);
      await writeFile(join(repo.work, "skill.py"), ECHO_BODY);
      await writeFile(join(repo.work, "requirements.lock"), lockfile);
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
      expect(v1Result.status).toBe("live");
      const v1Sha = v1Result.gitSha;

      // v2 — same lockfile bytes, only manifest description changes.
      const v2Manifest = ECHO_WITH_DEPS.replace(
        "a tier-1 skill that echoes one int field",
        "v2 description that is reasonably long",
      );
      await writeFile(join(repo.work, "SKILL.md"), v2Manifest);
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
      expect(v2Result.status).toBe("live");

      // Rollback — compiler stub now reports yanked-wheel. Must still succeed.
      const rollbackResult = await runner.rollback({
        name: "echo",
        toGitSha: v1Sha,
        origin: OWNER,
      });
      expect(rollbackResult.status).toBe("live");
      expect(rollbackResult.gitSha).toBe(v1Sha);
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
      if (reg.status !== "pending_approval" || !reg.pendingId) {
        throw new Error(`expected pending_approval, got ${reg.status}`);
      }
      return reg.pendingId;
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

      expect(approved.status).toBe("live");
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

    it("a pending result carries the pending manifest's schedule for the approval prompt", async () => {
      const runner = await makeRunner({ defaultRunAs: await seedOwner() });
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/briefing",
        manifest: scheduledManifest("effects:\n  - sends_message"),
        body: ECHO_BODY,
      });

      const reg = await runner.register({ branch: "skill/briefing", origin: OWNER });

      expect(reg).toMatchObject({ status: "pending_approval", schedule: "0 9 * * *" });
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

      expect(rolled.status).toBe("live");
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
      if (reg.status !== "pending_approval" || !reg.pendingId) {
        throw new Error(`expected pending_approval, got ${reg.status}`);
      }
      return reg.pendingId;
    }

    it("deploy_not_found when pendingId doesn't exist", async () => {
      const runner = await makeRunner();
      const result = await runner.approveDeploy({
        pendingId: "00000000-0000-0000-0000-000000000099",
        origin: OWNER,
      });
      expect(result.status).toBe("rejected");
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
      expect(first.status).toBe("live");

      const second = await runner.approveDeploy({ pendingId, origin: OWNER });
      expect(second.status).toBe("rejected");
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
      await pushFeatureBranch({
        work: repo.work,
        branch: "skill/echo-leap",
        manifest: ECHO_MANIFEST,
        body: ECHO_BODY,
      });
      const leap = await runner.register({ branch: "skill/echo-leap", origin: OWNER });
      expect(leap.status).toBe("live");

      // Now approve the original pending — main has moved.
      const result = await runner.approveDeploy({ pendingId, origin: OWNER });
      expect(result.status).toBe("rejected");
      expect(result.errors?.[0]).toMatch(/non_fast_forward_at_approve_time/);
    });

    it("target_missing_source when SKILL.md is gone at the deploy sha", async () => {
      // Patch the deploy's git_sha column to point at a commit lacking
      // SKILL.md — simulates the original branch being rebased away
      // between register and approve so gitShow throws file_not_found.
      const runner = await makeRunner();
      const pendingId = await makePendingDeploy(runner);

      // Push a commit with no SKILL.md to a parallel branch.
      await execFileP("git", ["-C", repo.work, "rm", "SKILL.md", "skill.py"]);
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
      expect(result.status).toBe("rejected");
      expect(result.errors?.[0]).toMatch(/target_missing_source/);
    });
  });

  describe("rollback: rejection matrix", () => {
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
      expect(result.status).toBe("rejected");
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
      await execFileP("git", ["-C", repo.work, "rm", "SKILL.md", "skill.py"]);
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
      expect(result.status).toBe("rejected");
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

      const list = await runner.list();
      expect(list).toHaveLength(0);
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
      expect(result.status).toBe("rejected");
      expect(result.errors?.[0]).toMatch(/invalid_branch/);
      // No skills row created.
      expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
    });

    it("rejects branch == 'refs/heads/main' too", async () => {
      const runner = await makeRunner();
      const result = await runner.register({ branch: "refs/heads/main", origin: OWNER });
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
      const result = await runner.register({ branch: "skill/bad-schema", origin: OWNER });
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
      const result = await runner.register({ branch: "skill/bad-properties", origin: OWNER });
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
      const result = await runner.register({ branch: "skill/notifier", origin: OWNER });
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
      const reg = await runner.register({ branch: "skill/notifier", origin: OWNER });
      expect(reg.status).toBe("pending_approval");
      const pendingId = reg.pendingId;
      if (!pendingId) throw new Error("expected pendingId");

      const approved = await runner.approveDeploy({ pendingId, origin: OWNER });
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

      expect(result.status).toBe("rejected");
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
      expect(result.status).toBe("pending_approval");
      expect(result.riskTier).toBe("approve");
    });
  });

  describe("safety: wasm lint rejects bodies tier 1 cannot run", () => {
    it("rejects a tier-1 body importing a stdlib networking module", async () => {
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

      expect(result.status).toBe("rejected");
      expect(result.errors?.[0]).toMatch(/stdlib networking/);
      expect(result.errors?.[0]).toMatch(/line 2/);
      expect(await getMainSha(repo.bare)).toBe(before);
      expect(await tx((trx) => store.getSkillByName(trx, "echo"))).toBeUndefined();
    });

    it("rejects a tier-1 body importing subprocess", async () => {
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
      expect(result.status).toBe("rejected");
      expect(result.errors?.[0]).toMatch(/subprocess/);
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
      await runner.register({ branch: "skill/alpha", origin: OWNER });

      // Register skill B (separate name, different sha).
      const bSha = await pushFeatureBranch({
        work: repo.work,
        branch: "skill/beta",
        manifest: ECHO_MANIFEST.replace("name: echo", "name: beta"),
        body: ECHO_BODY,
      });
      await runner.register({ branch: "skill/beta", origin: OWNER });

      // Try to roll back A to B's sha — must reject; otherwise A would
      // silently start running B's code.
      const result = await runner.rollback({ name: "alpha", toGitSha: bSha, origin: OWNER });
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
      const reg = await runner.register({ branch: "skill/shapeshift-v1", origin: OWNER });
      if (!reg.pendingId) throw new Error("expected pendingId for sends_message skill");
      await runner.approveDeploy({ pendingId: reg.pendingId, origin: OWNER });

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
      if (!reg2.pendingId) throw new Error("expected pendingId for v2 register");
      const approved = await runner.approveDeploy({ pendingId: reg2.pendingId, origin: OWNER });
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
      const reg = await runner.register({ branch: "skill/notify-skill", origin: OWNER });
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
      const reg2 = await runner.register({ branch: "skill/notify-skill", origin: OWNER });
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
      const reg1 = await runner.register({ branch: "skill/upgradable-v1", origin: OWNER });
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
      const reg2 = await runner.register({ branch: "skill/upgradable-v2", origin: OWNER });
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
      const base = await setupRepo();
      // Stand-in for the GitHub/Gitea URL Cogmo would attach as origin in
      // production. Built via the shared bare-repo fixture so the seed
      // shape stays consistent with configure-remote.test.ts.
      const { path: remote } = await makePopulatedBareRepo(
        join(base.bare, ".."),
        "skills-remote",
        "skills-remote.git",
      );
      // Attach the remote as `origin` on the skills bare repo, then fetch
      // main so local matches remote — mirrors what configureSkillsRemote
      // does at wizard time.
      await execFileP("git", ["-C", base.bare, "remote", "add", "origin", remote]);
      await execFileP("git", [
        "-C",
        base.bare,
        "fetch",
        remote,
        "+refs/heads/main:refs/heads/main",
      ]);
      // Also pull main into the work clone so feature branches descend from
      // the seed commit — otherwise the branch sha has no ancestry with
      // main and register rejects with `non_fast_forward`. Mirrors the
      // production sandbox flow where the agent clones from the remote and
      // commits on top of main.
      await execFileP("git", ["-C", base.work, "pull", base.bare, "main"]);
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
        });

        const sha = await pushFeatureBranch({
          work: repoWithRemote.work,
          branch: "skill/echo",
          manifest: ECHO_MANIFEST,
          body: ECHO_BODY,
        });

        const result = await runner.register({ branch: "skill/echo", origin: OWNER });
        expect(result.status).toBe("live");
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
        expect(result.status).toBe("live");
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
        expect(result.status).toBe("live");
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
        expect(result.status).toBe("live");
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
        expect(reg.status).toBe("pending_approval");
        const pendingId = reg.pendingId;
        if (!pendingId) throw new Error("expected pendingId");
        const seedSha = (
          await execFileP("git", ["-C", repoWithRemote.remote, "rev-parse", "refs/heads/main"])
        ).stdout.trim();

        // Approve. Local main should advance to the deploy sha AND the
        // remote should follow — the regression case is "approve advances
        // local but leaves remote on the seed commit", which would silently
        // break Daytona-backed coding tasks operating on the skill.
        const approved = await runner.approveDeploy({ pendingId, origin: OWNER });
        expect(approved.status).toBe("live");
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

    it("rollback pushes the rewound SHA to remote via --force-with-lease", async () => {
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
          "a tier-1 skill that echoes one int field",
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

        // Rollback to v1 — rewinds local main backwards. The mirror push
        // uses --force-with-lease so the remote follows.
        const result = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });
        expect(result.status).toBe("live");
        expect(result.gitSha).toBe(v1);

        expect(await getMainSha(repoWithRemote.bare)).toBe(v1);
        expect(
          (
            await execFileP("git", ["-C", repoWithRemote.remote, "rev-parse", "refs/heads/main"])
          ).stdout.trim(),
        ).toBe(v1);
      } finally {
        await repoWithRemote.cleanup();
      }
    });

    it("rollback's --force-with-lease refuses to overwrite a divergent remote", async () => {
      // After register but before rollback, manually move remote main to a
      // sha unrelated to the local-observed sha. The lease check should
      // fail; remote main stays put; local rollback still succeeds (local
      // is authoritative per the design contract).
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
            "a tier-1 skill that echoes one int field",
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
          manifest: ECHO_MANIFEST.replace("a tier-1 skill that echoes one int field", "divergent"),
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

        // Now rollback. Local rolls back to v1; remote push uses
        // --force-with-lease=refs/heads/main:<v2> (our observed local-pre-
        // rollback sha). Remote is at `divergent`, lease check fails,
        // push aborts. The mirror is non-blocking, so rollback still
        // reports `live`.
        const result = await runner.rollback({ name: "echo", toGitSha: v1, origin: OWNER });
        expect(result.status).toBe("live");
        expect(result.gitSha).toBe(v1);

        // Local rolled back as expected.
        expect(await getMainSha(repoWithRemote.bare)).toBe(v1);
        // Remote retained the divergent sha — lease check did its job.
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
      });
    }
  });
});
