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

**This tool is asynchronous.** It submits the task and returns immediately with a taskId. The plan, approval prompt, and execution updates appear in the chat as new messages from Cogmo — not in your tool result. So:
- Do NOT wait for the plan in your reply. Acknowledge the submission briefly ("Submitted — I'll let you know when the plan's ready" or similar) and return.
- Do NOT speculate about plan content, file lists, or expected outcomes. The CLI's own plan is authoritative; your guesses would conflict with it.
- Do NOT call the tool a second time for the same goal — the first call is already running. Cancel via the message keyboard if needed.

If the sandbox is not initialized (dev machine without SANDBOX_RUNTIME), the tool throws a clear error — relay the message to the user and suggest they configure it. If the repo has reached its concurrent-task limit, the tool returns \`status: "rejected"\` with a reason — surface it.`;

export const delegateCodingTool: ToolSpec = defineTool({
  name: "delegate_coding",
  description:
    "Submit a multi-step coding task to Claude Code in a sandboxed container. Returns immediately " +
    "with a taskId — the plan, approval prompt, and execution updates arrive as separate chat " +
    "messages. Use when the task spans many files or needs running tests.",
  // Durable: creates a coding_tasks row and emits the start event. Non-
  // durable it would spawn a duplicate coding task on every step boundary
  // after the call.
  durable: true,
  schema: DelegateCodingInput,
  handler: async ({ goal, repo }, service, ctx) => {
    if (!service.coding) {
      throw new Error(
        "Coding delegation is unavailable — the sandbox module is not initialized. " +
          "Set SANDBOX_RUNTIME (sysbox in prod, runc for dev/CI) and restart Cogmo.",
      );
    }
    // The call context's key rides through to `coding_tasks.idempotency_key`.
    // This tool is `durable: true`, so replays are already covered; the key
    // closes the narrower window where the row commits and the process dies
    // before Inngest records the step result.
    const result = await service.coding.delegate({
      goal,
      repoName: repo,
      ...(ctx !== undefined && { idempotencyKey: `delegate_coding:${ctx.idempotencyKey}` }),
    });
    if (result.status === "rejected") {
      return JSON.stringify({ ok: false, reason: result.reason });
    }
    return JSON.stringify({
      ok: true,
      taskId: result.taskId,
      status: result.status,
      nextStep:
        "Task submitted. The plan will post as a separate message with Approve / Revise / Cancel " +
        "buttons. Acknowledge the submission to the user and stop — don't speculate about plan " +
        "content.",
    });
  },
});
