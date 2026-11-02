/** Taps on the plan, pipeline-gate and skill deploy keyboards, as what the adapter writes back. */

import { match, P } from "ts-pattern";
import type { ParsedSkillsDeployCallback } from "../../../../skills/skills-keyboard.js";
import type { Transport } from "../../../transport.js";
import type { TransportError } from "../../../transport-error.js";
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
  const reason = match(parsed.action)
    .with("revise", () => "user_requested_revisions" as const)
    .with("cancel", () => "user_cancelled" as const)
    .exhaustive();
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

export interface SkillsDeployCallbackOutcome {
  editText: string;
  toast: string;
  /**
   * Whether the keyboard should go. Yes once the tap resolved the row or found
   * it gone; no while the row is still actionable: a rejected tapper, an
   * approve the runner refused (the deploy stays pending, so Deny and a later
   * Approve still apply) or an unwired skills runtime.
   */
  clearKeyboard: boolean;
}

/**
 * Whether `error` leaves the deploy keyboard's buttons still usable. The
 * three codes name every failure that writes nothing: the row stays as it
 * was, so the same taps still apply. Every other code the skills namespace
 * returns resolved the row or found it gone. `TransportError` is the
 * transport-wide union, so the remainder is the other namespaces' codes,
 * which no skills tap can produce.
 */
function keepsSkillsKeyboard(error: TransportError): boolean {
  return match(error)
    .with(
      { code: P.union("identity_rejected", "skill_deploy_register_failed", "skills_disabled") },
      () => true,
    )
    .otherwise(() => false);
}

/**
 * Skill deploy-keyboard callback handler — translates a parsed Approve /
 * Deny tap on a pending deploy, or a Disable tap on a live skill, into a
 * `transport.skills` call and an outcome the adapter renders. The Transport
 * resolves the tapper's identity; an approval also takes the chat the tap
 * came from (`platformAddress`), whose conversation is its origin.
 */
export async function handleSkillsDeployCallback(
  transport: Transport,
  parsed: ParsedSkillsDeployCallback,
  tapperPlatformHandle: string,
  platformAddress: string,
): Promise<SkillsDeployCallbackOutcome> {
  return match(parsed)
    .with({ action: "approve" }, async ({ pendingId }) => {
      const res = await transport.skills.approveDeploy(
        pendingId,
        tapperPlatformHandle,
        platformAddress,
      );
      if (res.isErr()) {
        return {
          editText: errorMessage(res.error),
          toast: errorMessage(res.error),
          clearKeyboard: !keepsSkillsKeyboard(res.error),
        };
      }
      return {
        editText: `✅ Approved: '${res.value.skillName}' is now live (${res.value.gitSha.slice(0, 7)}).`,
        toast: "Approved",
        clearKeyboard: true,
      };
    })
    .with({ action: "deny" }, async ({ pendingId }) => {
      const res = await transport.skills.denyDeploy(pendingId, tapperPlatformHandle);
      if (res.isErr()) {
        return {
          editText: errorMessage(res.error),
          toast: errorMessage(res.error),
          clearKeyboard: !keepsSkillsKeyboard(res.error),
        };
      }
      return {
        editText: "❌ Deploy denied — main did not move. Register again to retry.",
        toast: "Denied",
        clearKeyboard: true,
      };
    })
    .with({ action: "disable" }, async ({ skillId }) => {
      const res = await transport.skills.disableById(skillId, tapperPlatformHandle);
      if (res.isErr()) {
        return {
          editText: errorMessage(res.error),
          toast: errorMessage(res.error),
          clearKeyboard: !keepsSkillsKeyboard(res.error),
        };
      }
      return {
        editText: `🚫 Skill ${res.value.name} disabled. /enable ${res.value.name} re-enables it.`,
        toast: "Disabled",
        clearKeyboard: true,
      };
    })
    .exhaustive();
}
