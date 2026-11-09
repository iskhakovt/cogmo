import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../db/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { commitAsCogmo, writeEditedTree } from "./cogmo-commits.js";
import { configurableMainSha, isCogmoOnlyMain, migrateSkillsLayout } from "./migrate-layout.js";
import { bootstrapSkillsRepo } from "./repo.js";
import { DrizzleSkillStore, type InsertSkillParams } from "./store/index.js";
import { findSkillsImageDir, loadReleaseToolchain } from "./toolchain.js";
import { commitToolchain } from "./toolchain-commit.js";

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
  vi.restoreAllMocks();
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

let root: string;
let bare: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-layout-"));
  bare = join(root, "skills.git");
  work = join(root, "work");
  await bootstrapSkillsRepo({ path: bare });
  await execFileP("git", ["init", "-q", "-b", "main", work]);
  await execFileP("git", ["-C", work, "config", "user.email", "author@test"]);
  await execFileP("git", ["-C", work, "config", "user.name", "author"]);
  await execFileP("git", ["-C", work, "config", "commit.gpgsign", "false"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await execFileP("git", ["-C", repo, ...args])).stdout.trim();
}

/**
 * Commit `files` (paths from the root; null deletes) in the working clone and
 * move the bare repo's `main` to it, as a register did before the layout.
 */
async function commitOnMain(
  files: Record<string, string | null>,
  message: string,
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(work, path), { force: true });
    } else {
      await mkdir(dirname(join(work, path)), { recursive: true });
      await writeFile(join(work, path), content);
    }
  }
  await execFileP("git", ["-C", work, "add", "-A"]);
  await execFileP("git", ["-C", work, "commit", "-q", "--allow-empty", "-m", message]);
  const sha = await git(work, "rev-parse", "HEAD");
  await execFileP("git", ["-C", work, "push", "-q", bare, "HEAD:refs/heads/staging"]);
  await git(bare, "update-ref", "refs/heads/main", sha);
  return sha;
}

function manifest(name: string): string {
  return `---\nname: ${name}\ndescription: the ${name} skill\ntier: wasm\n---\n`;
}

async function seedSkill(name: string, gitSha: string, disabled: boolean): Promise<void> {
  const params: InsertSkillParams = {
    name,
    tier: "wasm",
    riskTier: "auto",
    effects: [],
    schedule: null,
    scheduleNextRunAt: null,
    gitSha,
    lockfileHash: null,
    inputs: { type: "object", properties: {} },
    outputs: null,
    scheduleRunAs: null,
  };
  const row = await tx((trx) => store.insertSkill(trx, params));
  if (disabled) await tx((trx) => store.disableSkill(trx, row.id));
}

const migrate = () => migrateSkillsLayout({ runInTx: tx, store }, bare);

describe("migrateSkillsLayout", () => {
  it("records a parentless layout commit on an unborn main", async () => {
    const layout = await migrate();

    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(layout);
    expect(await git(bare, "log", "-1", "--format=%P|%ae|%ce|%B", layout)).toBe(
      "|skills@cogmo.invalid|skills@cogmo.invalid|chore(skills): move each skill to skills/<name>/\n\nCogmo-Layout: v1",
    );
    expect(await git(bare, "ls-tree", "-r", "--name-only", layout)).toBe("");
    expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBe(layout);
  });

  it("copies each skill on main from its own sha to skills/<name>/ and drops the root files", async () => {
    const alpha = await commitOnMain(
      {
        "README.md": "the library\n",
        "SKILL.md": manifest("alpha"),
        "skill.py": "alpha = 1\n",
        // Nothing read skills/ before the move.
        "skills/stray/notes.md": "x\n",
      },
      "c",
    );
    const beta = await commitOnMain(
      {
        "SKILL.md": manifest("beta"),
        "skill.py": "beta = 1\n",
        "requirements.lock": "idna==3.10\n",
      },
      "c",
    );
    // A pending first deploy's sha is not on main.
    await execFileP("git", ["-C", work, "checkout", "-q", "-b", "pending"]);
    await commitOnMain({ "SKILL.md": manifest("delta"), "skill.py": "delta = 1\n" }, "c");
    const delta = await git(work, "rev-parse", "HEAD");
    await git(bare, "update-ref", "refs/heads/main", beta);
    await seedSkill("alpha", alpha, true);
    await seedSkill("beta", beta, false);
    await seedSkill("delta", delta, true);

    const layout = await migrate();

    expect(await git(bare, "rev-parse", `${layout}^`)).toBe(beta);
    expect((await git(bare, "ls-tree", "-r", "--name-only", layout)).split("\n")).toEqual([
      "README.md",
      "skills/alpha/SKILL.md",
      "skills/alpha/skill.py",
      "skills/beta/SKILL.md",
      "skills/beta/requirements.lock",
      "skills/beta/skill.py",
    ]);
    expect(await git(bare, "show", `${layout}:skills/alpha/skill.py`)).toBe("alpha = 1");
    expect(await git(bare, "rev-parse", `${layout}:skills/beta/requirements.lock`)).toBe(
      await git(bare, "rev-parse", `${beta}:requirements.lock`),
    );
    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(layout);
  });

  it("does nothing once the layout commit is recorded", async () => {
    const layout = await migrate();
    await execFileP("git", ["-C", work, "fetch", "-q", bare, "main"]);
    await execFileP("git", ["-C", work, "reset", "-q", "--hard", "FETCH_HEAD"]);
    await commitOnMain({ "skills/echo/SKILL.md": manifest("echo") }, "c");
    const main = await git(bare, "rev-parse", "refs/heads/main");

    expect(await migrate()).toBe(layout);
    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(main);
  });

  it("records a layout commit already on main instead of making a second", async () => {
    const alpha = await commitOnMain({ "SKILL.md": manifest("alpha"), "skill.py": "a\n" }, "c");
    await seedSkill("alpha", alpha, false);
    const layout = await migrate();
    // The process died after update-ref, before the row committed.
    await db.execute(sql`DELETE FROM skills_repo_layout`);

    expect(await migrate()).toBe(layout);
    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(layout);
    expect(await git(bare, "rev-list", "--count", "refs/heads/main")).toBe("2");
  });

  it("moves the mirror state behind to the layout commit it makes", async () => {
    const alpha = await commitOnMain({ "SKILL.md": manifest("alpha"), "skill.py": "a\n" }, "c");
    await seedSkill("alpha", alpha, false);
    await tx(async (trx) => {
      await store.ensureMirror(trx);
      await store.markMainAdvanced(trx, alpha);
      await store.recordMirrorLanded(trx, alpha);
    });

    const layout = await migrate();

    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
      status: "behind",
      localSha: layout,
      pushedSha: alpha,
    });
  });

  it("brings the mirror state up to main when it records a layout commit a crash left", async () => {
    const alpha = await commitOnMain({ "SKILL.md": manifest("alpha"), "skill.py": "a\n" }, "c");
    await seedSkill("alpha", alpha, false);
    await tx(async (trx) => {
      await store.ensureMirror(trx);
      await store.markMainAdvanced(trx, alpha);
    });
    const layout = await migrate();
    // The crash left neither the layout row nor the mirror's move.
    await db.execute(sql`DELETE FROM skills_repo_layout`);
    await db.execute(sql`UPDATE skills_repo_mirror SET local_sha = ${alpha}`);

    expect(await migrate()).toBe(layout);
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({ localSha: layout });
  });

  /**
   * alpha deployed at the repo root, the layout commit on top, then a deploy
   * of beta from a draft cut before the move that merged `main`, so the
   * layout commit is the merge's second parent. Returns both commits.
   */
  async function mergeDeployFromPreLayoutBase(): Promise<{ layout: string; merge: string }> {
    const alpha = await commitOnMain({ "SKILL.md": manifest("alpha"), "skill.py": "a\n" }, "c");
    await seedSkill("alpha", alpha, false);
    const layout = await migrate();
    await git(work, "checkout", "-q", "-b", "draft", alpha);
    await mkdir(join(work, "skills", "beta"), { recursive: true });
    await writeFile(join(work, "skills", "beta", "SKILL.md"), manifest("beta"));
    await writeFile(join(work, "skills", "beta", "skill.py"), "b\n");
    await git(work, "add", "-A");
    await git(work, "commit", "-q", "-m", "add beta");
    await git(work, "fetch", "-q", bare, "main");
    await git(work, "merge", "-q", "--no-edit", "FETCH_HEAD");
    const merge = await git(work, "rev-parse", "HEAD");
    expect(await git(work, "rev-parse", `${merge}^2`)).toBe(layout);
    await git(work, "push", "-q", bare, "HEAD:refs/heads/staging");
    await git(bare, "update-ref", "refs/heads/main", merge);
    return { layout, merge };
  }

  it("records a layout commit a merge deploy took off main's first-parent history", async () => {
    const { layout, merge } = await mergeDeployFromPreLayoutBase();
    await seedSkill("beta", merge, false);
    await db.execute(sql`DELETE FROM skills_repo_layout`);

    expect(await migrate()).toBe(layout);
    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(merge);
  });

  it("records that layout commit with no skills rows, as an adopt into a fresh database does", async () => {
    const { layout, merge } = await mergeDeployFromPreLayoutBase();
    await truncateAll(db);

    expect(await migrate()).toBe(layout);
    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(merge);
    expect(await git(bare, "ls-tree", "-r", "--name-only", "refs/heads/main")).toContain(
      "skills/beta/skill.py",
    );
  });

  /** A bare layout commit from another repo's boot, dated before every other commit. */
  async function unrelatedBareLayoutCommit(): Promise<string> {
    const emptyTree = await git(bare, "hash-object", "-t", "tree", "-w", "/dev/null");
    const date = "2000-01-01T00:00:00Z";
    return (
      await execFileP(
        "git",
        ["-C", bare, "commit-tree", emptyTree, "-m", "c", "-m", "Cogmo-Layout: v1"],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Cogmo",
            GIT_AUTHOR_EMAIL: "skills@cogmo.invalid",
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_NAME: "Cogmo",
            GIT_COMMITTER_EMAIL: "skills@cogmo.invalid",
            GIT_COMMITTER_DATE: date,
          },
        },
      )
    ).stdout.trim();
  }

  /** Point main at an author's merge of `side` into `first`, keeping `first`'s tree. */
  async function mergeOnMain(first: string, side: string): Promise<string> {
    const tree = await git(bare, "rev-parse", `${first}^{tree}`);
    const merge = (
      await execFileP(
        "git",
        ["-C", bare, "commit-tree", tree, "-p", first, "-p", side, "-m", "m"],
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
    await git(bare, "update-ref", "refs/heads/main", merge);
    return merge;
  }

  it("records the layout commit on main's first-parent history over one a merge brought in", async () => {
    const alpha = await commitOnMain({ "SKILL.md": manifest("alpha"), "skill.py": "a\n" }, "c");
    await seedSkill("alpha", alpha, false);
    const layout = await migrate();
    await mergeOnMain(layout, await unrelatedBareLayoutCommit());
    await db.execute(sql`DELETE FROM skills_repo_layout`);

    expect(await migrate()).toBe(layout);
  });

  it("fails the boot when main merges two layout commits and its first-parent history holds none", async () => {
    const { layout, merge } = await mergeDeployFromPreLayoutBase();
    await seedSkill("beta", merge, false);
    const unrelated = await unrelatedBareLayoutCommit();
    const main = await mergeOnMain(merge, unrelated);
    await db.execute(sql`DELETE FROM skills_repo_layout`);

    await expect(migrate()).rejects.toThrow(
      `main's history merges more than one layout commit, none on its first-parent history: ${unrelated}, ${layout}`,
    );
    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(main);
    expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBeNull();
  });

  it("skips a commit carrying the layout trailer under another identity", async () => {
    const forged = await commitOnMain({ "README.md": "x\n" }, "c\n\nCogmo-Layout: v1");

    const layout = await migrate();

    expect(layout).not.toBe(forged);
    expect(await git(bare, "rev-parse", `${layout}^`)).toBe(forged);
  });

  it("rebuilds the move from a fresh main when a register moves main under it", async () => {
    const alpha = await commitOnMain({ "SKILL.md": manifest("alpha"), "skill.py": "a\n" }, "c");
    await seedSkill("alpha", alpha, false);
    const record = store.recordLayoutCommit.bind(store);
    let moved = "";
    vi.spyOn(store, "recordLayoutCommit").mockImplementationOnce(async (trx, sha) => {
      // A deploy lands between the reads and the compare-and-swap.
      moved = await commitOnMain({ "README.md": "moved\n" }, "c");
      return record(trx, sha);
    });

    const layout = await migrate();

    expect(await git(bare, "rev-parse", `${layout}^`)).toBe(moved);
    expect(await git(bare, "show", `${layout}:skills/alpha/skill.py`)).toBe("a");
    expect(await git(bare, "show", `${layout}:README.md`)).toBe("moved");
    expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBe(layout);
  });

  it("skips a Cogmo layout commit whose tree keeps skill files at the root", async () => {
    const legacy = await commitOnMain({ "SKILL.md": manifest("alpha"), "skill.py": "a\n" }, "c");
    await seedSkill("alpha", legacy, false);
    const tree = await git(bare, "rev-parse", `${legacy}^{tree}`);
    const forged = (
      await execFileP(
        "git",
        ["-C", bare, "commit-tree", tree, "-p", legacy, "-m", "c", "-m", "Cogmo-Layout: v1"],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Cogmo",
            GIT_AUTHOR_EMAIL: "skills@cogmo.invalid",
            GIT_COMMITTER_NAME: "Cogmo",
            GIT_COMMITTER_EMAIL: "skills@cogmo.invalid",
          },
        },
      )
    ).stdout.trim();
    await git(bare, "update-ref", "refs/heads/main", forged);

    const layout = await migrate();

    expect(layout).not.toBe(forged);
    expect(await git(bare, "rev-parse", `${layout}^`)).toBe(forged);
    expect(await git(bare, "show", `${layout}:skills/alpha/skill.py`)).toBe("a");
  });

  it("skips a Cogmo layout commit whose tree lacks a skill on its history", async () => {
    const legacy = await commitOnMain({ "SKILL.md": manifest("alpha"), "skill.py": "a\n" }, "c");
    await seedSkill("alpha", legacy, false);
    const emptyTree = await git(bare, "hash-object", "-t", "tree", "-w", "/dev/null");
    const forged = (
      await execFileP(
        "git",
        ["-C", bare, "commit-tree", emptyTree, "-p", legacy, "-m", "c", "-m", "Cogmo-Layout: v1"],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Cogmo",
            GIT_AUTHOR_EMAIL: "skills@cogmo.invalid",
            GIT_COMMITTER_NAME: "Cogmo",
            GIT_COMMITTER_EMAIL: "skills@cogmo.invalid",
          },
        },
      )
    ).stdout.trim();
    await git(bare, "update-ref", "refs/heads/main", forged);

    const layout = await migrate();

    expect(layout).not.toBe(forged);
    expect(await git(bare, "rev-parse", `${layout}^`)).toBe(forged);
  });

  it("moves again when a recorded bare layout commit is no longer under main", async () => {
    const recordedBare = await migrate();
    // An adopt replaced main while a boot recorded the bare commit again.
    const adopted = await commitOnMain({ "README.md": "adopted\n" }, "c");
    await git(bare, "update-ref", "refs/heads/main", await git(work, "rev-parse", "HEAD"));
    expect(adopted).not.toBe(recordedBare);
    const orphanMain = (
      await execFileP(
        "git",
        [
          "-C",
          bare,
          "commit-tree",
          await git(bare, "rev-parse", `${adopted}^{tree}`),
          "-m",
          "remote",
        ],
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
    await git(bare, "update-ref", "refs/heads/main", orphanMain);

    const layout = await migrate();

    expect(layout).not.toBe(recordedBare);
    expect(await git(bare, "rev-parse", `${layout}^`)).toBe(orphanMain);
    expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBe(layout);
  });

  it("moves again when main is unborn under a recorded layout commit", async () => {
    await migrate();
    // The operator deletes main, as remote_diverged advises before an adopt.
    await git(bare, "update-ref", "-d", "refs/heads/main");

    const layout = await migrate();

    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(layout);
    expect(await git(bare, "log", "-1", "--format=%P|%T", layout)).toBe(
      "|4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    );
    expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBe(layout);
  });

  it("moves again when the repo no longer has the recorded layout commit", async () => {
    await tx((trx) => store.recordLayoutCommit(trx, "f".repeat(40)));

    const layout = await migrate();

    expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBe(layout);
    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(layout);
  });

  it("fails the boot, leaving main and the row as they were, when the row holds another commit", async () => {
    const alpha = await commitOnMain({ "SKILL.md": manifest("alpha"), "skill.py": "a\n" }, "c");
    await seedSkill("alpha", alpha, false);
    const record = DrizzleSkillStore.prototype.recordLayoutCommit.bind(store);
    vi.spyOn(store, "recordLayoutCommit").mockImplementationOnce(async (trx, sha) => {
      // The row is written, so the null below shows the throw rolled it back.
      await record(trx, sha);
      return "f".repeat(40);
    });

    await expect(migrate()).rejects.toThrow(/the row holds f{40}/);
    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(alpha);
    expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBeNull();
  });

  it("fails the boot when main moves under every attempt", { timeout: 30_000 }, async () => {
    const record = store.recordLayoutCommit.bind(store);
    let deploys = 0;
    const spy = vi.spyOn(store, "recordLayoutCommit").mockImplementation(async (trx, sha) => {
      deploys += 1;
      await commitOnMain({ "README.md": `deploy ${deploys}\n` }, "c");
      return record(trx, sha);
    });

    await expect(migrate()).rejects.toThrow(/main moved under each of 5 attempts/);
    expect(spy).toHaveBeenCalledTimes(5);
    expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBeNull();
  });

  it("fails the boot when a skill on main has no files at its sha", async () => {
    const empty = await commitOnMain({ "README.md": "x\n" }, "c");
    await seedSkill("ghost", empty, false);

    await expect(migrate()).rejects.toThrow(/skill 'ghost' at [0-9a-f]+ has no skill files/);
    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(empty);
    expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBeNull();
  });
});

describe("isCogmoOnlyMain", () => {
  const head = () => git(bare, "rev-parse", "refs/heads/main");
  const toolchain = async () =>
    commitToolchain(
      { runInTx: tx, store },
      bare,
      await loadReleaseToolchain(findSkillsImageDir(import.meta.url), "9.9.9"),
    );

  /** A commit under Cogmo's identity on top of main, carrying `trailers` and putting `files`. */
  async function cogmoCommit(
    trailers: Record<string, string>,
    files: Record<string, string>,
  ): Promise<string> {
    const parent = await head();
    const puts = [];
    for (const [path, content] of Object.entries(files)) {
      const file = join(root, "blob");
      await writeFile(file, content);
      puts.push({
        kind: "put" as const,
        path,
        blob: { mode: "100644", sha: await git(bare, "hash-object", "-w", file) },
      });
    }
    const tree = await writeEditedTree(bare, parent, puts);
    const sha = await commitAsCogmo(bare, { tree, parent, subject: "c", trailers });
    await git(bare, "update-ref", "refs/heads/main", sha);
    return sha;
  }

  it("counts an unborn main as unborn", async () => {
    expect(await configurableMainSha(bare)).toBeNull();
  });

  it("holds for the bare layout commit alone", async () => {
    await migrate();

    expect(await isCogmoOnlyMain(bare, await head())).toBe(true);
    expect(await configurableMainSha(bare)).toBeNull();
  });

  it("holds for the bare layout commit and toolchain commits", async () => {
    await migrate();
    await toolchain();
    await cogmoCommit({ "Cogmo-Toolchain": "9.9.10" }, { "pyproject.toml": "newer\n" });

    expect(await isCogmoOnlyMain(bare, await head())).toBe(true);
    expect(await configurableMainSha(bare)).toBeNull();
  });

  it("fails once a toolchain commit's tree has a skills/ entry", async () => {
    await migrate();
    await toolchain();
    await cogmoCommit({ "Cogmo-Toolchain": "9.9.10" }, { "skills/echo/SKILL.md": "x\n" });

    expect(await isCogmoOnlyMain(bare, await head())).toBe(false);
    expect(await configurableMainSha(bare)).toBe(await head());
  });

  it.each([
    ["a restoring commit", { "Cogmo-Restores": "f".repeat(40) }],
    ["a reviewed commit", { "Cogmo-Toolchain": "9.9.10", "Cogmo-Reviewed": "abc" }],
    ["a commit with no Cogmo trailer", {}],
  ])("fails for %s on top", async (_label, trailers) => {
    await migrate();
    await toolchain();
    await cogmoCommit(trailers, { "notes.md": "x\n" });

    expect(await isCogmoOnlyMain(bare, await head())).toBe(false);
  });

  it("fails for an author's commit carrying the toolchain trailer", async () => {
    await migrate();
    await execFileP("git", ["-C", work, "fetch", "-q", bare, "main"]);
    await execFileP("git", ["-C", work, "reset", "-q", "--hard", "FETCH_HEAD"]);
    await commitOnMain({ "notes.md": "x\n" }, "c\n\nCogmo-Toolchain: 9.9.9");

    expect(await isCogmoOnlyMain(bare, await head())).toBe(false);
  });

  it("fails for a merge carrying the toolchain trailer", async () => {
    const layoutCommit = await migrate();
    const side = await cogmoCommit({ "Cogmo-Toolchain": "1" }, { "a.txt": "a\n" });
    const tree = await git(bare, "rev-parse", `${side}^{tree}`);
    const merge = (
      await execFileP(
        "git",
        [
          "-C",
          bare,
          "commit-tree",
          tree,
          "-p",
          layoutCommit,
          "-p",
          side,
          "-m",
          "c",
          "-m",
          "Cogmo-Toolchain: 1",
        ],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Cogmo",
            GIT_AUTHOR_EMAIL: "skills@cogmo.invalid",
            GIT_COMMITTER_NAME: "Cogmo",
            GIT_COMMITTER_EMAIL: "skills@cogmo.invalid",
          },
        },
      )
    ).stdout.trim();
    await git(bare, "update-ref", "refs/heads/main", merge);

    expect(await isCogmoOnlyMain(bare, merge)).toBe(false);
  });

  it("fails for toolchain commits on a main that began elsewhere", async () => {
    await commitOnMain({ "README.md": "the library\n" }, "c");
    await migrate();
    await toolchain();

    expect(await isCogmoOnlyMain(bare, await head())).toBe(false);
  });
});
