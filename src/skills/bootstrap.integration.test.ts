/// <reference path="../../test/vitest.d.ts" />

/**
 * Bootstrap integration test — verifies `bootstrapSkillsRepo` runs against a
 * real filesystem (not a unit test tempdir, but the integration setup's
 * tempdir-as-COGMO_SKILLS_PATH). Tests the actual production hook install
 * + idempotency contract that the unit tier covers in isolation, but here
 * with the full integration path that boot uses.
 */

import { existsSync } from "node:fs";
import { chmod, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapSkillsRepo, PRE_RECEIVE_HOOK_CONTENT } from "./repo.js";

// COGMO_SKILLS_PATH is set by integration-setup.ts to a tempdir; reuse it.
const skillsPath = process.env.COGMO_SKILLS_PATH;

afterEach(async () => {
  // Restore hook to canonical state for subsequent tests in this file.
  if (skillsPath) {
    await bootstrapSkillsRepo({ path: skillsPath });
  }
});

describe("bootstrapSkillsRepo (integration)", () => {
  it("COGMO_SKILLS_PATH is set by integration setup", () => {
    expect(skillsPath).toBeTruthy();
    expect(skillsPath).toMatch(/cogmo-skills-it-/);
  });

  it("subsequent boots are idempotent and report initialized:false", async () => {
    if (!skillsPath) throw new Error("skillsPath unset");
    const r = await bootstrapSkillsRepo({ path: skillsPath });
    expect(r.initialized).toBe(false);
    expect(existsSync(join(skillsPath, "HEAD"))).toBe(true);
  });

  it("hook content matches the canonical PRE_RECEIVE_HOOK_CONTENT", async () => {
    if (!skillsPath) throw new Error("skillsPath unset");
    const hookPath = join(skillsPath, "hooks", "pre-receive");
    const content = await readFile(hookPath, "utf8");
    expect(content).toBe(PRE_RECEIVE_HOOK_CONTENT);
  });

  it("hook is mode 0755", async () => {
    if (!skillsPath) throw new Error("skillsPath unset");
    const hookPath = join(skillsPath, "hooks", "pre-receive");
    const st = await stat(hookPath);
    // biome-ignore lint/style/noMagicNumbers: explicit mode bits
    expect(st.mode & 0o777).toBe(0o755);
  });

  it("reinstalls the hook if it was deleted post-boot", async () => {
    if (!skillsPath) throw new Error("skillsPath unset");
    const hookPath = join(skillsPath, "hooks", "pre-receive");
    await unlink(hookPath);
    expect(existsSync(hookPath)).toBe(false);

    await bootstrapSkillsRepo({ path: skillsPath });
    expect(existsSync(hookPath)).toBe(true);
    expect(await readFile(hookPath, "utf8")).toBe(PRE_RECEIVE_HOOK_CONTENT);
  });

  it("fixes mode if the hook was downgraded externally", async () => {
    if (!skillsPath) throw new Error("skillsPath unset");
    const hookPath = join(skillsPath, "hooks", "pre-receive");
    // biome-ignore lint/style/noMagicNumbers: explicit mode bits
    await chmod(hookPath, 0o644);
    await bootstrapSkillsRepo({ path: skillsPath });
    const st = await stat(hookPath);
    // biome-ignore lint/style/noMagicNumbers: explicit mode bits
    expect(st.mode & 0o777).toBe(0o755);
  });
});
