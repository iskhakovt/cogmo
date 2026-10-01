import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readSkillSource } from "./skill-source.js";

const execFileP = promisify(execFile);

const MANIFEST = `---
name: echo
description: a tier-1 skill that echoes its inputs
tier: wasm
inputs:
  type: object
  properties: {}
---
`;

const roots: string[] = [];

/** A repo with one commit holding `files`; returns its path and the commit sha. */
async function commit(files: Record<string, string>): Promise<{ repo: string; sha: string }> {
  const repo = await mkdtemp(join(tmpdir(), "skills-source-"));
  roots.push(repo);
  await execFileP("git", ["init", "-q", "-b", "main", repo]);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(repo, name), content);
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
  return { repo, sha: stdout.trim() };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("readSkillSource", () => {
  it("reads and parses the manifest and body", async () => {
    const { repo, sha } = await commit({ "SKILL.md": MANIFEST, "skill.py": "body\n" });
    const source = (await readSkillSource(repo, sha))._unsafeUnwrap();
    expect(source.manifest.name).toBe("echo");
    expect(source.body).toBe("body\n");
  });

  it("errs naming SKILL.md when the manifest is absent", async () => {
    const { repo, sha } = await commit({ "skill.py": "body\n" });
    expect((await readSkillSource(repo, sha))._unsafeUnwrapErr()).toEqual({
      kind: "missing_file",
      file: "SKILL.md",
    });
  });

  it("errs naming skill.py when the body is absent", async () => {
    const { repo, sha } = await commit({ "SKILL.md": MANIFEST });
    expect((await readSkillSource(repo, sha))._unsafeUnwrapErr()).toEqual({
      kind: "missing_file",
      file: "skill.py",
    });
  });

  it("errs with the manifest's issues when it does not parse", async () => {
    const { repo, sha } = await commit({ "SKILL.md": "no frontmatter", "skill.py": "body\n" });
    const error = (await readSkillSource(repo, sha))._unsafeUnwrapErr();
    expect(error.kind).toBe("invalid_manifest");
  });

  it("errs with commit_not_found when the sha does not resolve", async () => {
    const { repo } = await commit({});
    expect((await readSkillSource(repo, "refs/heads/missing"))._unsafeUnwrapErr()).toEqual({
      kind: "commit_not_found",
    });
  });
});
