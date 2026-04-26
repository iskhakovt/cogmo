import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";

/**
 * Slice-1 plan-phase prompt. Hardcoded template; slice 4+ wires this through
 * `DefaultPromptSource` so coding-scoped steering rules layer on top.
 *
 * Repo conventions are NOT inlined — Claude Code loads `/workspace/CLAUDE.md`,
 * `~/.claude/CLAUDE.md`, and `/etc/claude-code/CLAUDE.md` natively from its
 * memory tiers. See design/coding-delegation.md → "Injected context".
 */
export function buildPlanPrompt(task: CodingTaskRow, repo: CodingRepoRow): string {
  if (!task.worktreeAssignment) {
    throw new Error(`buildPlanPrompt called for task ${task.id} before worktree was allocated`);
  }
  return [
    "# Task",
    task.goal,
    "",
    "# Environment",
    "- Repo root is /workspace. Stay inside it.",
    `- Current branch: ${task.worktreeAssignment.branch}. Already created and checked out.`,
    "- Git credentials are NOT available in plan mode — you cannot push or pull.",
    "- Do NOT make any edits. Plan only.",
    "",
    "# Verify command (for context — runs after execution, not during plan)",
    repo.verifyCommand,
    "",
    "# Budget",
    `Aim to keep the task within ~${repo.taskTokenBudget} tokens of execution. ` +
      "If the task is too large, narrow scope rather than promise the moon.",
    "",
    "# When finished",
    'Produce a "## Plan" section describing the steps you would take, the files you would touch, ' +
      "and how you would verify. Cogmo posts this plan to the human for approval before any " +
      "execution. No edits, no commits, no pushes.",
  ].join("\n");
}
