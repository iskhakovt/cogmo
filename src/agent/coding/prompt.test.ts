import { describe, expect, it } from "vitest";
import { buildPlanPrompt } from "./prompt.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";

function repo(overrides: Partial<CodingRepoRow> = {}): CodingRepoRow {
  return {
    id: "r",
    name: "cogmo",
    localPath: "/repos/cogmo",
    defaultBranch: "main",
    remoteUrl: "git@github.com:user/cogmo.git",
    devcontainer: null,
    allowedBackends: ["claude"],
    verifyCommand: "pnpm typecheck && pnpm lint && pnpm test",
    taskTokenBudget: 200_000,
    taskWallTimeSeconds: 1800,
    maxConcurrentTasks: 1,
    identityName: "default",
    verifyTimeoutSeconds: 600,
    createdAt: new Date(),
    ...overrides,
  };
}

function task(overrides: Partial<CodingTaskRow> = {}): CodingTaskRow {
  return {
    id: "t",
    repoId: "r",
    conversationId: null,
    goal: "refactor steering rules to support per-channel scoping",
    triggerSource: "user",
    triggerRef: null,
    backend: "claude",
    worktreeAssignment: { branch: "cogmo/abc123", worktreePath: "/worktrees/abc123" },
    sessionId: null,
    containerId: null,
    allowPrivilegedRunc: false,
    plan: null,
    planApprovedAt: null,
    prMetadata: null,
    status: "queued",
    failureReason: null,
    resourceUsage: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("buildPlanPrompt", () => {
  it("interpolates goal, branch, verify command, and budget", () => {
    const out = buildPlanPrompt(task(), repo());
    expect(out).toContain("# Task");
    expect(out).toContain("refactor steering rules to support per-channel scoping");
    expect(out).toContain("Current branch: cogmo/abc123");
    expect(out).toContain("pnpm typecheck && pnpm lint && pnpm test");
    expect(out).toContain("~200000 tokens");
  });

  it("instructs the CLI to plan only — no edits, commits, pushes", () => {
    const out = buildPlanPrompt(task(), repo());
    expect(out).toMatch(/no edits.*no commits.*no pushes/i);
    expect(out).toContain("## Plan");
  });

  it("does not inline repo conventions (those load from CLAUDE.md tiers)", () => {
    const out = buildPlanPrompt(task(), repo());
    // No mention of the project's own CLAUDE.md content — Claude Code reads it natively.
    expect(out).not.toMatch(/CLAUDE\.md/);
  });
});
