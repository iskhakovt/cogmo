import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ok } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { skillsRepoAt } from "../../test/skills-repo.js";
import type { LockfileCompiler } from "../deps.js";
import type { SkillsRepo } from "../skill-files.js";
import { SkillManifestSchema } from "../types.js";
import { readManifestLockfile } from "./lockfile-check.js";

const execFileP = promisify(execFile);

/** Pins pydantic at another version than the runtime's. */
const SHADOWING_LOCKFILE = "pydantic==2.14.3 --hash=sha256:0\n";

let dir: string;
let repo: SkillsRepo;
let sha: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "skills-lockfile-check-"));
  await execFileP("git", ["init", "-b", "main", dir]);
  await execFileP("git", ["-C", dir, "config", "user.email", "test@cogmo.dev"]);
  await execFileP("git", ["-C", dir, "config", "user.name", "test"]);
  await mkdir(join(dir, "skills", "echo"), { recursive: true });
  await writeFile(join(dir, "skills", "echo", "requirements.lock"), SHADOWING_LOCKFILE);
  await execFileP("git", ["-C", dir, "add", "."]);
  await execFileP("git", ["-C", dir, "commit", "-m", "lockfile"]);
  sha = (await execFileP("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  repo = skillsRepoAt(dir, sha);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const manifest = SkillManifestSchema.parse({
  name: "echo",
  description: "echoes its inputs back",
  tier: "container",
  inputs: { type: "object", properties: {} },
  dependencies: ["pydantic==2.14.3"],
});

describe("readManifestLockfile", () => {
  it("refuses a lockfile that shadows the runtime's pydantic when it verifies fresh, before compiling", async () => {
    const compiler = {
      compile: vi.fn<LockfileCompiler["compile"]>(async () => ok(SHADOWING_LOCKFILE)),
    };
    const read = await readManifestLockfile(compiler, repo, sha, manifest, { verifyFresh: true });
    expect(read._unsafeUnwrapErr()).toMatch(/^runtime_package_conflict: /);
    expect(compiler.compile).not.toHaveBeenCalled();
  });

  it("keeps a revision's lockfile as it went live in rollback mode", async () => {
    const read = await readManifestLockfile(undefined, repo, sha, manifest, { verifyFresh: false });
    expect(read._unsafeUnwrap()?.contents).toBe(SHADOWING_LOCKFILE);
  });
});
