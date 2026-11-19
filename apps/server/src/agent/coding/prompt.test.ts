import { describe, expect, it } from "vitest";
import { ENTRYPOINT_RULE } from "../../skills/ast-rules.js";
import { SKILLS_CODING_REPO_NAME } from "../../skills/repo.js";
import { gateGuidanceSignature } from "../../test/skills-fixtures.js";
import { buildFixPrompt, buildPlanPrompt } from "./prompt.js";
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
    worktreeAssignment: {
      type: "host-path",
      branch: "cogmo/abc123",
      worktreePath: "/worktrees/abc123",
    },
    sessionId: null,
    containerId: null,
    allowPrivilegedRunc: false,
    plan: null,
    planApprovedAt: null,
    prMetadata: null,
    status: "queued",
    failureReason: null,
    failureDetail: null,
    resourceUsage: null,
    idempotencyKey: null,
    claimedByRunId: null,
    presubmitVerdict: null,
    presubmitFixPasses: 0,
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

  it("states the Entrypoint gate's rule to the skills repo, with a signature the gates accept", async () => {
    const out = buildPlanPrompt(task(), repo({ name: SKILLS_CODING_REPO_NAME }));
    expect(out).toContain(ENTRYPOINT_RULE);
    expect(await gateGuidanceSignature(out)).toEqual([]);
  });
});

describe("buildFixPrompt", () => {
  const planned = () => task({ plan: "## Plan\n1. Write skills/echo/skill.py\n" });
  const fix = {
    findings: ["ruff: skills/echo/skill.py:1:1: E501 Line too long", "pyrefly: bad-return"],
    tokenBudgetLeft: 42_000,
  };

  it("carries the goal, the approved plan and the findings verbatim, for a session with no scrollback", () => {
    const out = buildFixPrompt(planned(), repo({ name: SKILLS_CODING_REPO_NAME }), fix);
    expect(out).toContain("# Task\nrefactor steering rules to support per-channel scoping");
    expect(out).toContain("# Approved plan\n## Plan\n1. Write skills/echo/skill.py");
    expect(out).toContain(`\`\`\`\n${fix.findings.join("\n")}\n\`\`\``);
    expect(out).toContain("cogmo/abc123 already holds the work");
  });

  it("asks for commits on top, no amend or rebase, findings first, with the verify rerun", () => {
    const out = buildFixPrompt(planned(), repo({ name: SKILLS_CODING_REPO_NAME }), fix);
    expect(out).toMatch(/Commit on top of the branch\. Do not amend, rebase or reset/);
    expect(out).toContain("Change only what the findings name.");
    // An `owned_paths` finding is fixed outside the skill's directory.
    expect(out).toContain(
      "A finding about a file outside the skill's directory is fixed by restoring it to `main`'s version, or deleting it if `main` has none.",
    );
    expect(out).toContain(
      "Where the task asks for something the findings refuse, the findings win.",
    );
    expect(out).toContain("Run the verify command");
    expect(out).toContain("pnpm typecheck && pnpm lint && pnpm test");
    expect(out).toContain(ENTRYPOINT_RULE);
  });

  it("fences the findings one backtick longer than the longest run inside them", () => {
    const fenced = { ...fix, findings: ["skill.py:3: ````python is not closed", "a `x` b ```"] };
    const out = buildFixPrompt(planned(), repo(), fenced);
    expect(out).toContain(`\`\`\`\`\`\n${fenced.findings.join("\n")}\n\`\`\`\`\`\n`);
    expect(buildFixPrompt(planned(), repo(), { ...fix, findings: ["a `x` b"] })).toContain(
      "```\na `x` b\n```\n",
    );
  });

  it("names the token budget left", () => {
    expect(buildFixPrompt(planned(), repo(), fix)).toContain("About 42000 tokens");
  });

  it("refuses a task with no plan", () => {
    expect(() => buildFixPrompt(task(), repo(), fix)).toThrow(/without a worktree and a plan/);
  });
});
