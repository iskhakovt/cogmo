/// <reference path="../../test/vitest.d.ts" />

/**
 * Bootstrap integration test — verifies `bootstrapSkillsRepo` against a real
 * filesystem. Uses its own per-file tempdir (not the global
 * `COGMO_SKILLS_PATH`) so vitest can run it in parallel with other
 * integration files that also touch the bare repo without races on the
 * shared path.
 */

import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bootstrapSkillsRepo, PRE_RECEIVE_HOOK_CONTENT } from "./repo.js";

let skillsPath: string;

beforeAll(async () => {
  skillsPath = await mkdtemp(join(tmpdir(), "cogmo-skills-bootstrap-it-"));
  await bootstrapSkillsRepo({ path: skillsPath });
});

afterAll(async () => {
  await rm(skillsPath, { recursive: true, force: true });
});

afterEach(async () => {
  // Restore hook to canonical state for subsequent tests in this file.
  await bootstrapSkillsRepo({ path: skillsPath });
});

describe("bootstrapSkillsRepo (integration)", () => {
  it("subsequent boots are idempotent and report initialized:false", async () => {
    const r = await bootstrapSkillsRepo({ path: skillsPath });
    expect(r.initialized).toBe(false);
    expect(existsSync(join(skillsPath, "HEAD"))).toBe(true);
  });

  it("hook content matches the canonical PRE_RECEIVE_HOOK_CONTENT", async () => {
    const hookPath = join(skillsPath, "hooks", "pre-receive");
    const content = await readFile(hookPath, "utf8");
    expect(content).toBe(PRE_RECEIVE_HOOK_CONTENT);
  });

  it("hook is mode 0755", async () => {
    const hookPath = join(skillsPath, "hooks", "pre-receive");
    const st = await stat(hookPath);
    expect(st.mode & 0o777).toBe(0o755);
  });

  it("reinstalls the hook if it was deleted post-boot", async () => {
    const hookPath = join(skillsPath, "hooks", "pre-receive");
    await unlink(hookPath);
    expect(existsSync(hookPath)).toBe(false);

    await bootstrapSkillsRepo({ path: skillsPath });
    expect(existsSync(hookPath)).toBe(true);
    expect(await readFile(hookPath, "utf8")).toBe(PRE_RECEIVE_HOOK_CONTENT);
  });

  it("fixes mode if the hook was downgraded externally", async () => {
    const hookPath = join(skillsPath, "hooks", "pre-receive");
    await chmod(hookPath, 0o644);
    await bootstrapSkillsRepo({ path: skillsPath });
    const st = await stat(hookPath);
    expect(st.mode & 0o777).toBe(0o755);
  });
});
