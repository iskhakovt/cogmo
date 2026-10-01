/** Taps on the plan, pipeline-gate and skills-approval keyboards, as what the adapter writes back. */

import type { Transport } from "../../../transport.js";
import { errorMessage } from "./reply.js";

/**
 * Result the Telegram adapter renders for a plan-callback tap. Pure data —
 * `editText` replaces the plan-message body (and clears the keyboard);
 * `followUp`, when set, posts as a separate chat message (used by Revise);
 * `toast` is the small popup Telegram shows on the tapping device only.
 */
export interface PlanCallbackOutcome {
  editText: string;
  followUp?: string;
  toast: string;
}

/**
 * Pure handler for Approve / Revise / Cancel taps on the plan keyboard.
 * Resolves identity (only the conversation owner can act), dispatches the
 * appropriate `transport.coding.*` call, and returns the rendering
 * instructions for the Telegram side.
 *
 * Idempotent against double-taps via Transport's atomic store methods.
 */
export async function handlePlanCallback(
  transport: Transport,
  parsed: { taskId: string; action: "approve" | "revise" | "cancel" },
  tapperPlatformHandle: string,
): Promise<PlanCallbackOutcome> {
  if (parsed.action === "approve") {
    const res = await transport.coding.approvePlan(parsed.taskId, tapperPlatformHandle);
    if (res.isErr()) return { editText: errorMessage(res.error), toast: errorMessage(res.error) };
    return {
      editText: "✅ Plan approved. Execution starting…",
      toast: "Approved",
    };
  }

  // Revise & Cancel both end the current task — Revise additionally tells
  // the user how to continue. "Revise" is conversational
  // (matches Cursor / Devin / Claude Code's plan mode): the user describes
  // what to change, and the agent issues a fresh delegate_coding next
  // turn. In-place plan editing requires an editor surface Telegram
  // doesn't have.
  const reason =
    parsed.action === "revise" ? "user requested revisions" : "user cancelled the plan";
  const res = await transport.coding.cancelTask(parsed.taskId, tapperPlatformHandle, reason);
  if (res.isErr()) return { editText: errorMessage(res.error), toast: errorMessage(res.error) };

  if (parsed.action === "revise") {
    return {
      editText: "✏️ Plan revised — see follow-up.",
      followUp:
        "Tell me what you'd like changed about the plan, and I'll re-delegate with your " +
        "feedback.",
      toast: "Revising",
    };
  }
  return { editText: "❌ Plan cancelled.", toast: "Cancelled" };
}

export interface PipelineGateCallbackOutcome {
  editText: string;
  toast: string;
  /**
   * Whether the keyboard should go. Yes unless the tapper was rejected: a
   * rejected tap must not take the buttons away from whoever can use them,
   * while every other outcome (sent, already resolved, run gone, pipelines
   * disabled) leaves buttons that can never do anything again.
   */
  clearKeyboard: boolean;
}

/**
 * Pure handler for Approve / Cancel taps on a pipeline gate keyboard.
 * Identity, the gate token and the parked-gate check live in
 * `transport.pipelines`; this only renders what the adapter writes back over
 * the keyboard. The text says the decision was sent, not that it won: a tap
 * can still lose to the gate's own timeout, and the resolver reports that.
 */
export async function handlePipelineGateCallback(
  transport: Transport,
  parsed: { runId: string; action: "approve" | "cancel"; token: string },
  tapperPlatformHandle: string,
): Promise<PipelineGateCallbackOutcome> {
  const res = await transport.pipelines.resolveGate(
    parsed.runId,
    parsed.token,
    parsed.action,
    tapperPlatformHandle,
  );
  if (res.isErr()) {
    return {
      editText: errorMessage(res.error),
      toast: errorMessage(res.error),
      clearKeyboard: res.error.code !== "identity_rejected",
    };
  }
  const { pipelineName, stageId } = res.value;
  return parsed.action === "approve"
    ? {
        editText: `✅ Approval sent for checkpoint "${stageId}" of pipeline "${pipelineName}".`,
        toast: "Approved",
        clearKeyboard: true,
      }
    : {
        editText: `❌ Cancellation sent for checkpoint "${stageId}" of pipeline "${pipelineName}".`,
        toast: "Cancelling",
        clearKeyboard: true,
      };
}

export interface SkillsApprovalCallbackOutcome {
  editText: string;
  toast: string;
}

/**
 * Skills-deploy approve-tier callback handler — translates a parsed Approve /
 * Deny tap into a `transport.skills.{approveDeploy,denyDeploy}` call and an
 * outcome the adapter renders. The Transport resolves the tapper's identity;
 * an approval also takes the chat the tap came from (`platformAddress`),
 * whose conversation is its origin.
 */
export async function handleSkillsApprovalCallback(
  transport: Transport,
  parsed: { pendingId: string; action: "approve" | "deny" },
  tapperPlatformHandle: string,
  platformAddress: string,
): Promise<SkillsApprovalCallbackOutcome> {
  if (parsed.action === "approve") {
    const res = await transport.skills.approveDeploy(
      parsed.pendingId,
      tapperPlatformHandle,
      platformAddress,
    );
    if (res.isErr()) {
      return { editText: errorMessage(res.error), toast: errorMessage(res.error) };
    }
    return {
      editText: `✅ Approved: '${res.value.skillName}' is now live (${res.value.gitSha.slice(0, 7)}).`,
      toast: "Approved",
    };
  }
  // deny
  const res = await transport.skills.denyDeploy(parsed.pendingId, tapperPlatformHandle);
  if (res.isErr()) {
    return { editText: errorMessage(res.error), toast: errorMessage(res.error) };
  }
  return {
    editText: "❌ Deploy denied — no main advance. Re-register a different version to retry.",
    toast: "Denied",
  };
}
