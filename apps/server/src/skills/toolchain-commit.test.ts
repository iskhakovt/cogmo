import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../db/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { migrateSkillsLayout } from "./migrate-layout.js";
import { ensureSkillsMirror } from "./mirror-reconcile.js";
import { bootstrapSkillsRepo } from "./repo.js";
import { DrizzleSkillStore } from "./store/index.js";
import {
  findSkillsImageDir,
  loadReleaseToolchain,
  type ReleaseToolchain,
  type ToolchainEntry,
} from "./toolchain.js";
import { commitToolchain } from "./toolchain-commit.js";

const execFileP = promisify(execFile);

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleSkillStore();
let shipped: ReleaseToolchain;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  shipped = await loadReleaseToolchain(findSkillsImageDir(import.meta.url), "9.9.9");
});

afterAll(async () => {
  await close();
});

let root: string;
let bare: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-toolchain-"));
  bare = join(root, "skills.git");
  work = join(root, "work");
  await bootstrapSkillsRepo({ path: bare });
  await execFileP("git", ["init", "-q", "-b", "main", work]);
  await git(work, "config", "user.email", "author@test");
  await git(work, "config", "user.name", "author");
  await git(work, "config", "commit.gpgsign", "false");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await truncateAll(db);
  await rm(root, { recursive: true, force: true });
});

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await execFileP("git", ["-C", repo, ...args])).stdout.trim();
}

const mainSha = () => git(bare, "rev-parse", "refs/heads/main");

/** The layout move on an unborn main, as the boot runs it first. */
const layout = () => migrateSkillsLayout({ runInTx: tx, store }, bare);

const commit = (release: ReleaseToolchain) =>
  commitToolchain({ runInTx: tx, store }, bare, release);

/**
 * Commit `files` (null deletes) on top of the bare repo's `main` from the
 * working clone and move `main` to it, as a deploy or an operator would.
 */
async function commitOnMain(files: Record<string, string | null>): Promise<string> {
  await git(work, "fetch", "-q", bare, "main");
  await git(work, "reset", "-q", "--hard", "FETCH_HEAD");
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(work, path), { recursive: true, force: true });
    } else {
      await mkdir(dirname(join(work, path)), { recursive: true });
      await writeFile(join(work, path), content);
    }
  }
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "--allow-empty", "-m", "c");
  const sha = await git(work, "rev-parse", "HEAD");
  await git(work, "push", "-q", "-f", bare, "HEAD:refs/heads/staging");
  await git(bare, "update-ref", "refs/heads/main", sha);
  return sha;
}

function file(name: string, content: string): ToolchainEntry {
  return { kind: "file", name, mode: "100644", content: Buffer.from(content) };
}

/** A release whose `.cogmo/paths` lists its root entries. */
function release(version: string, rest: readonly ToolchainEntry[]): ReleaseToolchain {
  const listed = [...rest.map((entry) => entry.name), ".cogmo"];
  return {
    version,
    entries: [
      ...rest,
      {
        kind: "tree",
        name: ".cogmo",
        entries: [
          file("paths", `${listed.join("\n")}\n`),
          { kind: "file", name: "verify", mode: "100755", content: Buffer.from("#!/bin/sh\n") },
        ],
      },
    ],
  };
}

async function treeOf(sha: string): Promise<string[]> {
  return (await git(bare, "ls-tree", "-r", "--format=%(objectmode) %(path)", sha)).split("\n");
}

describe("commitToolchain", () => {
  it("commits the release's toolchain on top of main under Cogmo's identity, marking the mirror", async () => {
    const layoutCommit = await layout();
    await tx((trx) => store.ensureMirror(trx));

    const outcome = await commit(shipped);

    const sha = await mainSha();
    expect(outcome._unsafeUnwrap()).toEqual({ kind: "committed", sha });
    expect(await git(bare, "log", "-1", "--format=%P|%an <%ae>|%cn <%ce>|%B", sha)).toBe(
      `${layoutCommit}|Cogmo <skills@cogmo.invalid>|Cogmo <skills@cogmo.invalid>|chore(skills): set Cogmo's toolchain to 9.9.9\n\nCogmo-Toolchain: 9.9.9`,
    );
    const tree = await treeOf(sha);
    expect(tree).toContain("100755 .cogmo/verify");
    expect(tree).toContain("100644 .cogmo/cogmo_ctx/__init__.py");
    expect(tree).toContain("100644 uv.lock");
    expect(tree.some((line) => line.includes("__pycache__"))).toBe(false);
    expect(await git(bare, "show", `${sha}:.cogmo/paths`)).toBe(
      "pyproject.toml\nuv.lock\nCLAUDE.md\n.gitignore\n.cogmo",
    );
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
      status: "behind",
      localSha: sha,
    });
  });

  it("writes nothing when every entry on main is the release's", async () => {
    await layout();
    await commit(shipped);
    const before = await mainSha();

    expect((await commit(shipped))._unsafeUnwrap()).toEqual({ kind: "unchanged" });
    expect(await mainSha()).toBe(before);
  });

  it("sets a differing entry to the release's and keeps the rest of main", async () => {
    await layout();
    await commit(shipped);
    // An operator edits a toolchain file beside a skill and a file of their own.
    const edited = await commitOnMain({
      "pyproject.toml": "[project]\nname = 'mine'\n",
      "README.md": "mine\n",
      "skills/echo/SKILL.md": "---\nname: echo\n---\n",
    });

    const outcome = await commit(shipped);

    const sha = await mainSha();
    expect(outcome._unsafeUnwrap()).toEqual({ kind: "committed", sha });
    expect(await git(bare, "rev-parse", `${sha}^`)).toBe(edited);
    expect(await git(bare, "rev-parse", `${sha}:pyproject.toml`)).toBe(
      await git(bare, "rev-parse", `${edited}^:pyproject.toml`),
    );
    expect(await git(bare, "show", `${sha}:README.md`)).toBe("mine");
    expect(await git(bare, "show", `${sha}:skills/echo/SKILL.md`)).toContain("name: echo");
  });

  it("keeps every file outside the toolchain when a path under .cogmo/ carries a newline", async () => {
    await layout();
    await commit(shipped);
    // A path whose newline would read as a second index record removing a skill file.
    const crafted = `.cogmo/junk\n0 ${"0".repeat(40)}\tskills/echo/skill.py`;
    const edited = await commitOnMain({
      "skills/echo/SKILL.md": "---\nname: echo\n---\n",
      "skills/echo/skill.py": "async def run(ctx, input):\n    return {}\n",
      [crafted]: "x\n",
    });

    const outcome = await commit(shipped);

    const sha = await mainSha();
    expect(outcome._unsafeUnwrap()).toEqual({ kind: "committed", sha });
    expect(await git(bare, "show", `${sha}:skills/echo/skill.py`)).toContain("async def run");
    expect(await git(bare, "rev-parse", `${sha}:.cogmo`)).toBe(
      await git(bare, "rev-parse", `${sha}^^:.cogmo`),
    );
    expect(await git(bare, "rev-parse", `${edited}:skills/echo/SKILL.md`)).toBe(
      await git(bare, "rev-parse", `${sha}:skills/echo/SKILL.md`),
    );
  });

  it("replaces an operator's directory at an entry the release claims", async () => {
    await layout();
    await commitOnMain({ "CLAUDE.md/notes.md": "x\n", ".cogmo/extra": "y\n" });
    await commit(release("1", [file("CLAUDE.md", "convention\n")]));

    const tree = await treeOf(await mainSha());
    expect(tree).toContain("100644 CLAUDE.md");
    expect(
      tree.filter((line) => line.includes("CLAUDE.md/") || line.includes(".cogmo/extra")),
    ).toEqual([]);
  });

  it("removes the entries main's list names that the release's does not", async () => {
    await layout();
    const older = release("1", [
      file("pyproject.toml", "a\n"),
      file("legacy.toml", "old\n"),
      { kind: "tree", name: "tools", entries: [file("lint.cfg", "x\n")] },
    ]);
    await commit(older);
    await commitOnMain({ "README.md": "kept\n" });

    await commit(release("2", [file("pyproject.toml", "b\n")]));

    const sha = await mainSha();
    expect(await treeOf(sha)).toEqual([
      "100644 .cogmo/paths",
      "100755 .cogmo/verify",
      "100644 README.md",
      "100644 pyproject.toml",
    ]);
    expect(await git(bare, "show", `${sha}:pyproject.toml`)).toBe("b");
  });

  it.each(["skills", "skill.py", "../outside"])(
    "errs naming %j, writing nothing, when main's list names it",
    async (entry) => {
      await layout();
      await commit(shipped);
      const edited = await commitOnMain({
        ".cogmo/paths": `pyproject.toml\n${entry}\n.cogmo\n`,
        "skills/echo/skill.py": "x = 1\n",
      });

      expect((await commit(shipped))._unsafeUnwrapErr()).toEqual({ kind: "refused_entry", entry });
      expect(await mainSha()).toBe(edited);
    },
  );

  it("retries from a fresh main when a deploy moves main under the swap", async () => {
    await layout();
    const mark = store.markMainAdvanced.bind(store);
    let deployed = "";
    vi.spyOn(store, "markMainAdvanced").mockImplementationOnce(async (trx, sha) => {
      deployed = await commitOnMain({ "skills/echo/skill.py": "x = 1\n" });
      return mark(trx, sha);
    });

    const outcome = await commit(shipped);

    const sha = await mainSha();
    expect(outcome._unsafeUnwrap()).toEqual({ kind: "committed", sha });
    expect(await git(bare, "rev-parse", `${sha}^`)).toBe(deployed);
    expect(await git(bare, "show", `${sha}:skills/echo/skill.py`)).toBe("x = 1");
    expect(await tx((trx) => store.getMirror(trx))).toBeNull();
  });

  it("fails the boot when main moves under every attempt", { timeout: 30_000 }, async () => {
    await layout();
    const mark = store.markMainAdvanced.bind(store);
    let deploys = 0;
    const spy = vi.spyOn(store, "markMainAdvanced").mockImplementation(async (trx, sha) => {
      deploys += 1;
      await commitOnMain({ [`skills/echo/v${deploys}.txt`]: "x\n" });
      return mark(trx, sha);
    });

    await expect(commit(shipped)).rejects.toThrow(/main moved under each of 5 attempts/);
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it("finds the entries equal after an update-ref whose transaction failed, and the mirror catches up", async () => {
    const layoutCommit = await layout();
    await ensureSkillsMirror({ runInTx: tx, store }, bare);
    // The transaction rolls back after its update-ref landed.
    const failing: Transactor = (cb) =>
      tx(async (trx) => {
        await cb(trx);
        throw new Error("commit failed");
      });

    await expect(commitToolchain({ runInTx: failing, store }, bare, shipped)).rejects.toThrow(
      "commit failed",
    );
    const landed = await mainSha();
    expect(await git(bare, "rev-parse", `${landed}^`)).toBe(layoutCommit);
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({ localSha: layoutCommit });

    // The next boot: its mirror catch-up, then the toolchain commit.
    await ensureSkillsMirror({ runInTx: tx, store }, bare);
    expect((await commit(shipped))._unsafeUnwrap()).toEqual({ kind: "unchanged" });
    expect(await mainSha()).toBe(landed);
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({ localSha: landed });
  });

  it("refuses an unborn main", async () => {
    await expect(commit(shipped)).rejects.toThrow(/main is unborn/);
  });
});
