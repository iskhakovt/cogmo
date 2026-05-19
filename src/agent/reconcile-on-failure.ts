/**
 * Worker-death reconcile for `handle-message`. Subscribes to
 * `inngest/function.failed` and re-emits `conversation/errored` when the
 * primary `onFailure` path didn't run — typically because the worker
 * disconnected mid-step (Inngest's connect-mode worker-death class)
 * before the handler block could fire.
 *
 * Bus-level dedup via the explicit `id: "errored-${runId}"`: this is the
 * same id `onFailure`'s `step.sendEvent("emit-conversation-errored")`
 * uses. Whichever path emits first wins; the second is dropped by
 * Inngest's event-id dedup window, so `recover-conversation` runs
 * exactly once per failed run regardless of which path observed the
 * failure. See design/agent-resilience.md → Triggers.
 *
 * Mirrors `src/agent/coding/reconcile-on-failure.ts` in shape; the two
 * differ in (a) what function id they accept, (b) which inner-event
 * fields they read, and (c) what durable event they emit.
 */

import type { Inngest } from "inngest";
import { conversationErrored, inboundReady, inngestFunctionFailed } from "../inngest/events.js";
import { logger } from "../logger.js";

const log = logger.child({ component: "handle-message.reconcile-on-failure" });

const HANDLE_MESSAGE_FUNCTION_ID = "handle-message";

/**
 * Matched by suffix to accept the bare id, `<app>-handle-message`, and
 * `<app>/handle-message` forms (Inngest prefixes function ids with the
 * client `appId` in connect mode). Same shape as
 * `matchesCodingOrchestrator`.
 */
export function matchesHandleMessage(functionId: string): boolean {
  return (
    functionId === HANDLE_MESSAGE_FUNCTION_ID ||
    functionId.endsWith(`-${HANDLE_MESSAGE_FUNCTION_ID}`) ||
    functionId.endsWith(`/${HANDLE_MESSAGE_FUNCTION_ID}`)
  );
}

export type ReconcileResult =
  | {
      status: "reconciled";
      conversationId: string;
      runId: string;
      triggerInboundId: string | null;
      errorMessage: string;
    }
  | { status: "skipped"; reason: "not_handle_message" }
  | { status: "skipped"; reason: "missing_conversation_id" }
  | { status: "skipped"; reason: "wrong_inner_event" };

/**
 * Pure decision function — takes the failed-run payload, decides whether
 * this reconcile should re-emit, and returns the data the durable wrapper
 * needs to build the event. No emit here so the wrapper can split the
 * decision and the `step.sendEvent` into separate durable steps.
 */
export function decideReconcile(payload: {
  functionId: string;
  runId: string;
  errorMessage: string;
  innerEventName: string;
  conversationId: string | undefined;
  triggerInboundId: string | null | undefined;
}): ReconcileResult {
  if (!matchesHandleMessage(payload.functionId)) {
    return { status: "skipped", reason: "not_handle_message" };
  }
  // `handle-message` is only triggered by `inbound/ready`. A failed run
  // with a different inner event name means something is misconfigured
  // upstream — log and skip rather than synthesize a `conversation/errored`
  // from a payload that doesn't carry a conversation id by contract.
  if (payload.innerEventName !== inboundReady.name) {
    log.warn(
      {
        functionId: payload.functionId,
        runId: payload.runId,
        innerEventName: payload.innerEventName,
      },
      "reconcile: failed handle-message run had unexpected inner event",
    );
    return { status: "skipped", reason: "wrong_inner_event" };
  }
  if (typeof payload.conversationId !== "string" || payload.conversationId.length === 0) {
    log.warn(
      { functionId: payload.functionId, runId: payload.runId },
      "reconcile: failed handle-message run missing conversationId",
    );
    return { status: "skipped", reason: "missing_conversation_id" };
  }
  return {
    status: "reconciled",
    conversationId: payload.conversationId,
    runId: payload.runId,
    triggerInboundId: payload.triggerInboundId ?? null,
    errorMessage: payload.errorMessage,
  };
}

export function createHandleMessageReconcile(inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "handle-message-reconcile",
      retries: 3,
      concurrency: { limit: 1, key: "event.data.run_id" },
      triggers: [inngestFunctionFailed],
    },
    async ({ event, step }) => {
      const { function_id, run_id, error } = event.data;
      const innerEvent = event.data.event;
      const conversationId = innerEvent.data.conversationId;
      const triggerInboundId = innerEvent.data.triggerInboundId;
      const errorMessage = error.message ?? error.name ?? "unknown";

      const decision = decideReconcile({
        functionId: function_id,
        runId: run_id,
        errorMessage,
        innerEventName: innerEvent.name,
        conversationId,
        triggerInboundId,
      });

      if (decision.status !== "reconciled") return decision;

      // Bus-level dedup via the explicit `id` — same shape `onFailure`'s
      // `emit-conversation-errored` step uses, so whichever path emits
      // first wins and `recover-conversation` runs exactly once.
      await step.sendEvent("emit-errored", {
        ...conversationErrored.create({
          conversationId: decision.conversationId,
          runId: decision.runId,
          triggerInboundId: decision.triggerInboundId,
          // `errorClass: "WorkerDeath"` distinguishes this path from
          // `onFailure`'s typical `NonRetriableError`. The evolution
          // failure-reflector can bucket by class to keep
          // worker-disconnect noise out of the model-error corpus.
          errorClass: "WorkerDeath",
          causeClass: null,
          errorMessage: `inngest run terminated abnormally (run_id ${decision.runId}, function_id ${function_id}): ${decision.errorMessage}`,
        }),
        id: `errored-${decision.runId}`,
      });

      log.warn(
        {
          conversationId: decision.conversationId,
          runId: decision.runId,
          functionId: function_id,
          errorMessage,
        },
        "reconcile: emitted conversation/errored from inngest/function.failed",
      );

      return decision;
    },
  );
}
