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

/**
 * Slice-2 execute-phase prompt. Sent on stdin after `claude --resume <sid>`
 * loads the prior plan-mode session — Claude already has the goal, repo
 * context, and its own plan in scrollback. This message just transitions it
 * from plan mode to execution and reaffirms the boundaries it must respect.
 */
export function buildExecutePrompt(repo: CodingRepoRow): string {
  return [
    "# Approved",
    "The plan you proposed has been approved. Proceed with the implementation.",
    "",
    "# Reminders",
    "- Stay on the current branch and inside /workspace.",
    "- Git credentials are NOT available — do not `git push` or `gh pr create`.",
    "  Cogmo handles push and PR opening after verifying your work.",
    "- When you believe the task is done, run the verify command and report",
    "  the result. If it fails, iterate.",
    "",
    "# Verify command",
    repo.verifyCommand,
  ].join("\n");
}
