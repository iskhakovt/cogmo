import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import { planGateEmission } from "../../agent/coding/plan-gate.js";
import type { CodingStore } from "../../agent/coding/store/index.js";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";

/**
 * Plan-approval surface for the slice 2.0e Telegram inline keyboard.
 * Each method takes the platform handle of the user who tapped — the
 * implementation resolves it to a userId and rejects with
 * `identity_rejected` if it doesn't match the conversation owner.
 *
 * Returns `sandbox_disabled` when the sandbox module isn't initialized
 * (parallels `repos`).
 */
export interface CodingNamespace {
  /**
   * Stamp `plan_approved_at` and emit `coding/task/plan-approved`. A second
   * tap still returns `task_already_approved` and makes no second state
   * change, but the event repeats: a stamp that is already there cannot
   * distinguish a double-tap from a first tap whose emit failed after the
   * transaction committed, and the emit is the only thing that starts the
   * execute run. The duplicate collapses at the bus on
   * `plan-approved-<taskId>`, and past that window the execute claim is
   * conditional on `awaiting_approval`. See `planGateEmission`.
   */
  approvePlan(
    taskId: string,
    tapperPlatformHandle: string,
  ): Promise<Result<{ taskId: string }, TransportError>>;
  /** Set status=`cancelled` with the supplied reason. Idempotent on terminal tasks. */
  cancelTask(
    taskId: string,
    tapperPlatformHandle: string,
    reason: string,
  ): Promise<Result<{ taskId: string }, TransportError>>;
}

export function createCoding(
  deps: TransportContext & { inngest: Inngest; codingStore: CodingStore | undefined },
): CodingNamespace {
  const { channelId, runInTx, transportStore, agentStore, inngest, codingStore } = deps;
  return {
    async approvePlan(taskId, tapperPlatformHandle) {
      if (!codingStore) return err({ code: "sandbox_disabled" as const });
      const identityCheck = await checkTaskOwnership(taskId, tapperPlatformHandle);
      if (identityCheck.isErr()) return err(identityCheck.error);
      // Capture the timestamp once and reuse it for both the DB row
      // and the Inngest event payload — the receiver downstream can
      // trust them to match without a second clock read.
      const approvedAt = new Date();
      const result = await runInTx((tx) =>
        codingStore.approvePlanIfPending(tx, taskId, approvedAt),
      );
      // Emit before branching on the outcome — `already_approved` owes an
      // event too. `planGateEmission` holds that rule for both callers and
      // explains why.
      const emission = planGateEmission(result, approvedAt);
      if (emission) {
        await inngest.send({
          name: "coding/task/plan-approved",
          data: { taskId, approvedAt: emission.approvedAt },
          // Bus-level dedup, same `<verb>-<taskId>` shape as the
          // orchestrators' emits. `approvePlanIfPending` above already
          // makes a double tap a no-op at the DB, but a callback
          // redelivery past that point would otherwise start a second
          // execute run — which the `awaiting_approval -> executing`
          // claim then skips, though collapsing it here is cheaper.
          id: `plan-approved-${taskId}`,
        });
      }
      switch (result.kind) {
        case "approved":
          return ok({ taskId });
        case "already_approved":
          // The toast still reads "already approved" — accurate whether
          // the emit above was the first one or a recovery.
          return err({ code: "task_already_approved" as const, taskId });
        case "not_pending":
          return err({
            code: "task_not_pending_approval" as const,
            taskId,
            status: result.status,
          });
        case "not_found":
          return err({ code: "task_not_found" as const, taskId });
      }
    },
    async cancelTask(taskId, tapperPlatformHandle, reason) {
      if (!codingStore) return err({ code: "sandbox_disabled" as const });
      const identityCheck = await checkTaskOwnership(taskId, tapperPlatformHandle);
      if (identityCheck.isErr()) return err(identityCheck.error);
      const result = await runInTx((tx) => codingStore.cancelTaskIfActive(tx, taskId, reason));
      switch (result.kind) {
        case "cancelled":
          return ok({ taskId });
        case "already_terminal":
          return err({
            code: "task_already_terminal" as const,
            taskId,
            status: result.status,
          });
        case "not_found":
          return err({ code: "task_not_found" as const, taskId });
      }
    },
  };

  /**
   * Strict identity check for task callbacks: the user who tapped the
   * keyboard must own the conversation that triggered the task. Resolves
   * the platform handle to a Cogmo userId via `transportStore.resolveUser`
   * and compares against `coding_tasks.conversation_id →
   * conversations.user_id`.
   *
   * Caveat: in single-user wildcard mode, `resolveUser` returns the same
   * userId for any platform handle — the check degenerates to "is this
   * channel known to Cogmo?". That's fine for personal deployments.
   * Multi-user channels with explicit identities (`auto_created=false`,
   * non-null `platform_handle`) get the strict comparison.
   */
  async function checkTaskOwnership(
    taskId: string,
    tapperPlatformHandle: string,
  ): Promise<Result<void, TransportError>> {
    if (!codingStore) return err({ code: "sandbox_disabled" as const });
    const task = await runInTx((tx) => codingStore.getTask(tx, taskId));
    if (!task) return err({ code: "task_not_found" as const, taskId });
    const taskConversationId = task.conversationId;
    if (!taskConversationId) {
      // Automated triggers (evolution, signal_pipeline) have no
      // conversation owner — there's no Telegram callback path for them
      // either, so this branch is defensive.
      return err({ code: "operation_not_permitted" as const });
    }
    return runInTx(async (tx) => {
      const conv = await agentStore.getConversation(tx, taskConversationId);
      if (!conv) return err({ code: "conversation_not_found" as const });
      const tapper = await transportStore.resolveUser(tx, channelId, tapperPlatformHandle);
      if (!tapper || tapper.userId !== conv.userId) {
        return err({ code: "identity_rejected" as const });
      }
      return ok(undefined);
    });
  }
}
