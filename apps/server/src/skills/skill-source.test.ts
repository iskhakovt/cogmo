import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { skillsRepoAt } from "../test/skills-repo.js";
import type { SkillsRepo } from "./skill-files.js";
import { readSkillSource } from "./skill-source.js";

const execFileP = promisify(execFile);

const MANIFEST = `---
name: echo
description: a wasm skill that echoes its inputs
tier: wasm
inputs:
  type: object
  properties: {}
---
`;

const roots: string[] = [];

/** Commit `files` (paths from the repo root) on top of `repo`'s HEAD; returns the commit's sha. */
async function commitIn(repo: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await execFileP("git", ["-C", repo, "add", "-A"]);
  await execFileP("git", [
    "-C",
    repo,
    "-c",
    "user.email=test@cogmo.dev",
    "-c",
    "user.name=test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "c",
  ]);
  const { stdout } = await execFileP("git", ["-C", repo, "rev-parse", "HEAD"]);
  return stdout.trim();
}

async function newRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "skills-source-"));
  roots.push(repo);
  await execFileP("git", ["init", "-q", "-b", "main", repo]);
  return repo;
}

/**
 * A repo whose layout commit is followed by one holding `files` in
 * `skills/echo/`; returns it and that sha.
 */
async function commit(files: Record<string, string>): Promise<{ repo: SkillsRepo; sha: string }> {
  const path = await newRepo();
  const layout = await commitIn(path, {});
  const sha = await commitIn(
    path,
    Object.fromEntries(
      Object.entries(files).map(([file, content]) => [`skills/echo/${file}`, content]),
    ),
  );
  return { repo: skillsRepoAt(path, layout), sha };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("readSkillSource", () => {
  it("reads and parses the manifest and body", async () => {
    const { repo, sha } = await commit({ "SKILL.md": MANIFEST, "skill.py": "body\n" });
    const source = (await readSkillSource(repo, "echo", sha))._unsafeUnwrap();
    expect(source.manifest.name).toBe("echo");
    expect(source.body).toBe("body\n");
  });

  it("errs naming SKILL.md when the manifest is absent", async () => {
    const { repo, sha } = await commit({ "skill.py": "body\n" });
    expect((await readSkillSource(repo, "echo", sha))._unsafeUnwrapErr()).toEqual({
      kind: "missing_file",
      file: "SKILL.md",
    });
  });

  it("errs naming skill.py when the body is absent", async () => {
    const { repo, sha } = await commit({ "SKILL.md": MANIFEST });
    expect((await readSkillSource(repo, "echo", sha))._unsafeUnwrapErr()).toEqual({
      kind: "missing_file",
      file: "skill.py",
    });
  });

  it("errs with the manifest's issues when it does not parse", async () => {
    const { repo, sha } = await commit({ "SKILL.md": "no frontmatter", "skill.py": "body\n" });
    const error = (await readSkillSource(repo, "echo", sha))._unsafeUnwrapErr();
    expect(error.kind).toBe("invalid_manifest");
  });

  it("reads a sha from before the layout commit at the repo root", async () => {
    const path = await newRepo();
    const legacy = await commitIn(path, { "SKILL.md": MANIFEST, "skill.py": "legacy\n" });
    const layout = await commitIn(path, {
      "skills/echo/SKILL.md": MANIFEST,
      "skills/echo/skill.py": "moved\n",
    });
    const repo = skillsRepoAt(path, layout);

    expect((await readSkillSource(repo, "echo", legacy))._unsafeUnwrap().body).toBe("legacy\n");
    expect((await readSkillSource(repo, "echo", layout))._unsafeUnwrap().body).toBe("moved\n");
  });

  it("does not read a skill's root files at a sha after the layout commit", async () => {
    const path = await newRepo();
    const layout = await commitIn(path, {});
    const sha = await commitIn(path, { "SKILL.md": MANIFEST, "skill.py": "root\n" });
    expect(
      (await readSkillSource(skillsRepoAt(path, layout), "echo", sha))._unsafeUnwrapErr(),
    ).toEqual({
      kind: "missing_file",
      file: "SKILL.md",
    });
  });

  it("errs with commit_not_found when the sha does not resolve", async () => {
    const { repo } = await commit({});
    expect((await readSkillSource(repo, "echo", "refs/heads/missing"))._unsafeUnwrapErr()).toEqual({
      kind: "commit_not_found",
    });
  });
});
