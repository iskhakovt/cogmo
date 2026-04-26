import { z } from "zod";
import { defineTool, type ToolSpec } from "../tools.js";

const DelegateCodingInput = z.object({
  goal: z
    .string()
    .min(10)
    .describe(
      "What you want done — a goal statement, not a plan. Be specific about scope and outcome. " +
        "Example: 'refactor steering rules to support per-channel scoping; add unit tests'.",
    ),
  repo: z
    .string()
    .describe("Repo name as registered via `/repo add`. Use `/repo list` to see available repos."),
});

export const DELEGATE_CODING_GUIDANCE = `You can delegate multi-step coding work to a sandboxed Claude Code subprocess via \`delegate_coding\`. Use it when:
- The user asks for code changes that span more than a couple of files, require running tests, or would normally take you many tool calls.
- The work targets a registered repo (see \`/repo list\`).

Slice 1 supports plan-only — \`delegate_coding\` returns a plan for human approval. The plan is the CLI's own assessment of what it would do; surface it to the user verbatim. Do NOT pre-summarise. Approval flow ships in the next slice.

If the sandbox is not initialized (dev machine without SANDBOX_RUNTIME), the tool throws a clear error — relay the message to the user and suggest they configure it.`;

export const delegateCodingTool: ToolSpec = defineTool({
  name: "delegate_coding",
  description:
    "Delegate a multi-step coding task to Claude Code in a sandboxed container. Returns a plan " +
    "for the user to approve. Slice 1: plan only — no edits, no PR. Use when the task spans " +
    "many files or needs running tests.",
  schema: DelegateCodingInput,
  handler: async ({ goal, repo }, service) => {
    if (!service.coding) {
      throw new Error(
        "Coding delegation is unavailable — the sandbox module is not initialized. " +
          "Set SANDBOX_RUNTIME (sysbox in prod, runc for dev/CI) and restart Cogmo.",
      );
    }
    const result = await service.coding.delegate({ goal, repoName: repo });
    if (result.status === "failed") {
      return JSON.stringify({
        ok: false,
        taskId: result.taskId,
        reason: result.failureReason ?? "plan phase failed",
      });
    }
    // The "approval keyboard ships in slice 2" hint is only meaningful when
    // the task parks at `awaiting_approval` — i.e. `trigger_source = user`.
    // Automated triggers (evolution, signal_pipeline) auto-advance to
    // `executing`, so the hint would be misleading there.
    const nextStep =
      result.status === "awaiting_approval"
        ? "Plan posted. Approval keyboard ships in slice 2 — for now, this task stays in " +
          "awaiting_approval status. Show the plan to the user verbatim."
        : undefined;
    return JSON.stringify({
      ok: true,
      taskId: result.taskId,
      status: result.status,
      plan: result.plan ?? "",
      ...(nextStep !== undefined && { nextStep }),
    });
  },
});
