import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { match } from "ts-pattern";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertKind, expectDefined } from "../test/assertions.js";
import { repoRoot } from "../test/repo-root.js";
import {
  findSkillsImageDir,
  loadReleaseToolchain,
  type ToolchainEntry,
  toolchainPathsAt,
} from "./toolchain.js";

const execFileP = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileP("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("toolchainPathsAt", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "toolchain-paths-"));
    await execFileP("git", ["init", "-q", "-b", "main", work]);
    await git(work, "config", "user.email", "t@t");
    await git(work, "config", "user.name", "t");
    await git(work, "config", "commit.gpgsign", "false");
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  async function commit(files: Record<string, string>): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(work, path)), { recursive: true });
      await writeFile(join(work, path), content);
    }
    await git(work, "add", "-A");
    await git(work, "commit", "-q", "--allow-empty", "-m", "c");
    return git(work, "rev-parse", "HEAD");
  }

  it("lists nothing for a commit without the file", async () => {
    const sha = await commit({ "README.md": "x\n" });
    expect((await toolchainPathsAt(work, sha))._unsafeUnwrap()).toEqual([]);
  });

  it("lists nothing when the path is a directory", async () => {
    const sha = await commit({ ".cogmo/paths/inner": "skills\n" });
    expect((await toolchainPathsAt(work, sha))._unsafeUnwrap()).toEqual([]);
  });

  it("reads one entry per line, skipping blank lines", async () => {
    const sha = await commit({
      ".cogmo/paths": "pyproject.toml\nuv.lock\n\nCLAUDE.md\n.gitignore\n.cogmo\n",
    });
    expect((await toolchainPathsAt(work, sha))._unsafeUnwrap()).toEqual([
      "pyproject.toml",
      "uv.lock",
      "CLAUDE.md",
      ".gitignore",
      ".cogmo",
    ]);
  });

  it.each([
    "skills",
    "SKILL.md",
    "skill.py",
    "requirements.lock",
    "test_skill.py",
    ".",
    "..",
    ".git",
    "a/b",
    "skills/echo",
    "/etc",
    "nul\0byte",
  ])("refuses a list naming %j, naming it", async (entry) => {
    const sha = await commit({ ".cogmo/paths": `pyproject.toml\n${entry}\n.cogmo\n` });
    expect((await toolchainPathsAt(work, sha))._unsafeUnwrapErr()).toEqual({
      kind: "refused_entry",
      entry,
    });
  });
});

/** Every file under `entries`, by path, with its mode. */
function filesOf(entries: readonly ToolchainEntry[], prefix: string): Map<string, string> {
  return new Map(
    entries.flatMap((entry): [string, string][] =>
      match(entry)
        .with({ kind: "tree" }, (tree) => [...filesOf(tree.entries, `${prefix}${tree.name}/`)])
        .with({ kind: "file" }, (file): [string, string][] => [
          [`${prefix}${file.name}`, file.mode],
        ])
        .exhaustive(),
    ),
  );
}

/** The source tree's `images/skills/`, found as a composition root finds it. */
const imageDir = () => findSkillsImageDir(import.meta.url);

describe("findSkillsImageDir", () => {
  it("finds the source tree's images/skills/ above a module", () => {
    expect(imageDir()).toBe(join(repoRoot(), "images", "skills"));
  });

  it("throws, naming the module, when no ancestor holds a toolchain", async () => {
    const lone = await mkdtemp(join(tmpdir(), "toolchain-none-"));
    try {
      const moduleUrl = pathToFileURL(join(lone, "dist", "main.js")).href;
      expect(() => findSkillsImageDir(moduleUrl)).toThrow(
        `no images/skills/toolchain/ above ${join(lone, "dist", "main.js")}`,
      );
    } finally {
      await rm(lone, { recursive: true, force: true });
    }
  });
});

describe("loadReleaseToolchain", () => {
  let fake: string;

  beforeEach(async () => {
    fake = await mkdtemp(join(tmpdir(), "toolchain-release-"));
    await mkdir(join(fake, "toolchain", ".cogmo"), { recursive: true });
    await mkdir(join(fake, "src", "cogmo_ctx"), { recursive: true });
    await writeFile(join(fake, "src", "cogmo_ctx", "__init__.py"), "");
  });

  afterEach(async () => {
    await rm(fake, { recursive: true, force: true });
  });

  it("throws when the release's own list names an entry the toolchain may not own", async () => {
    await writeFile(join(fake, "toolchain", ".cogmo", "paths"), "pyproject.toml\nskills\n.cogmo\n");

    await expect(loadReleaseToolchain(fake, "1")).rejects.toThrow(
      "the release's .cogmo/paths lists 'skills'",
    );
  });

  it("throws when a listed entry is neither a file nor a directory", async () => {
    await writeFile(join(fake, "toolchain", ".cogmo", "paths"), "CLAUDE.md\n.cogmo\n");
    await symlink("elsewhere.md", join(fake, "toolchain", "CLAUDE.md"));

    await expect(loadReleaseToolchain(fake, "1")).rejects.toThrow(
      `${join(fake, "toolchain", "CLAUDE.md")}, which is neither a file nor a directory`,
    );
  });

  it("reads a listed entry's bytes and executable bit", async () => {
    await writeFile(join(fake, "toolchain", ".cogmo", "paths"), "run.sh\n.cogmo\n");
    await writeFile(join(fake, "toolchain", "run.sh"), "#!/bin/sh\n");
    await chmod(join(fake, "toolchain", "run.sh"), 0o755);

    const release = await loadReleaseToolchain(fake, "1");

    expect(filesOf(release.entries, "")).toEqual(
      new Map([
        ["run.sh", "100755"],
        [".cogmo/paths", "100644"],
        [".cogmo/cogmo_ctx/__init__.py", "100644"],
      ]),
    );
  });

  it("yields the five root entries the release lists, under the version given", async () => {
    const release = await loadReleaseToolchain(imageDir(), "1.2.3");

    expect(release.version).toBe("1.2.3");
    expect(release.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["pyproject.toml", "file"],
      ["uv.lock", "file"],
      ["CLAUDE.md", "file"],
      [".gitignore", "file"],
      [".cogmo", "tree"],
    ]);
  });

  it("joins cogmo_ctx into .cogmo/ with the files git tracks, verify executable", async () => {
    const root = repoRoot();
    const release = await loadReleaseToolchain(imageDir(), "dev");
    const files = filesOf(release.entries, "");
    // What git would track: tracked, or untracked and not ignored.
    const tracked = async (dir: string) =>
      (
        await git(
          root,
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "--deduplicate",
          "--",
          dir,
        )
      )
        .split("\n")
        .filter((path) => path.length > 0)
        .map((path) => path.slice(dir.length));
    const expected = [
      ...(await tracked("images/skills/toolchain/")),
      ...(await tracked("images/skills/src/cogmo_ctx/")).map((path) => `.cogmo/cogmo_ctx/${path}`),
    ];

    expect([...files.keys()].sort()).toEqual(expected.sort());
    expect(files.get(".cogmo/verify")).toBe("100755");
    expect(files.get(".cogmo/paths")).toBe("100644");
    const verify = (await stat(join(root, "images/skills/toolchain/.cogmo/verify"))).mode;
    expect(verify & 0o111).not.toBe(0);
  });

  it("carries each file's bytes", async () => {
    const release = await loadReleaseToolchain(imageDir(), "dev");
    const cogmo = release.entries.find((entry) => entry.name === ".cogmo");
    assertKind(cogmo, "tree");
    const ctx = cogmo.entries.find((entry) => entry.name === "cogmo_ctx");
    assertKind(ctx, "tree");
    const init = expectDefined(
      ctx.entries.find((entry) => entry.name === "__init__.py"),
      "cogmo_ctx/__init__.py",
    );
    assertKind(init, "file");

    expect(Buffer.from(init.content)).toEqual(
      await readFile(join(repoRoot(), "images/skills/src/cogmo_ctx/__init__.py")),
    );
  });
});
