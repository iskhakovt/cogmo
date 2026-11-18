import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { err, ok } from "neverthrow";
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
    expect(read._unsafeUnwrapErr()).toEqual({
      kind: "invalid",
      message: expect.stringMatching(/^runtime_package_conflict: /),
    });
    expect(compiler.compile).not.toHaveBeenCalled();
  });

  it("errs with the compile's kind, so a compile that could not run tells itself from a refusal", async () => {
    const pinned = SkillManifestSchema.parse({ ...manifest, dependencies: ["httpx==0.27.0"] });
    const lockfileAt = async (contents: string): Promise<string> => {
      await writeFile(join(dir, "skills", "echo", "requirements.lock"), contents);
      await execFileP("git", ["-C", dir, "commit", "-qam", "httpx"]);
      return (await execFileP("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
    };
    const httpxSha = await lockfileAt("httpx==0.27.0 --hash=sha256:0\n");
    const compiling = (result: Awaited<ReturnType<LockfileCompiler["compile"]>>) => ({
      compile: vi.fn<LockfileCompiler["compile"]>(async () => result),
    });
    const read = (compiler: LockfileCompiler) =>
      readManifestLockfile(compiler, repo, httpxSha, pinned, { verifyFresh: true });

    expect(
      (
        await read(compiling(err({ kind: "transport_failed", message: "exec was disposed" })))
      )._unsafeUnwrapErr(),
    ).toEqual({
      kind: "transport_failed",
      message: "requirements_lock_transport_failed: exec was disposed",
    });
    expect(
      (
        await read(compiling(err({ kind: "resolver_failed", message: "no bogus==0" })))
      )._unsafeUnwrapErr(),
    ).toEqual({
      kind: "resolver_failed",
      message: "requirements_lock_resolver_failed: no bogus==0",
    });
    expect(
      (await read(compiling(ok("httpx==0.27.0 --hash=sha256:1\n"))))._unsafeUnwrapErr(),
    ).toEqual({ kind: "invalid", message: expect.stringMatching(/^requirements_lock_stale: /) });
  });

  it("keeps a revision's lockfile as it went live in rollback mode", async () => {
    const read = await readManifestLockfile(undefined, repo, sha, manifest, { verifyFresh: false });
    expect(read._unsafeUnwrap()?.contents).toBe(SHADOWING_LOCKFILE);
  });
});
