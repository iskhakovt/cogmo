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
import { buildConversationErroredEvent, inngestFunctionFailed } from "../inngest/events.js";
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
      functionId: string;
      triggerInboundId: string | null;
      errorMessage: string;
    }
  | { status: "skipped"; reason: "not_handle_message" }
  | { status: "skipped"; reason: "missing_conversation_id" };

/**
 * Decide whether this reconcile should re-emit and, if so, package the
 * fields the wrapper needs into a single typed value. Logs a `warn` on
 * the `missing_conversation_id` skip path so a misconfigured upstream
 * shows up in operator logs even when no event lands on the bus;
 * otherwise does no I/O — emit is the wrapper's job.
 *
 * The contract this gates on is `conversationId in event.data` — NOT the
 * inner event's `name`. `handle-message` has one trigger today
 * (`inbound/ready`), but the reconcile shouldn't break the day someone
 * adds a second trigger that also carries a `conversationId`. The
 * `inboundReady`-name-equality check that lived here before would have
 * routed those failures to a silent skip and lost cooldown on
 * worker-death for the new path — flagged on PR #297 review.
 */
export function decideReconcile(payload: {
  functionId: string;
  runId: string;
  errorMessage: string;
  conversationId: string | undefined;
  triggerInboundId: string | null | undefined;
}): ReconcileResult {
  if (!matchesHandleMessage(payload.functionId)) {
    return { status: "skipped", reason: "not_handle_message" };
  }
  if (typeof payload.conversationId !== "string" || payload.conversationId.length === 0) {
    // Empty-string check is intentionally defensive — `inboundReady.data`
    // declares `conversationId: z.string()` and `inngestFunctionFailed`
    // re-declares it optional via passthrough, so an empty string SHOULD
    // be unreachable under intact upstream validation. Don't weaken to
    // assume the schema can be trusted at this surface.
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
    functionId: payload.functionId,
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
        conversationId,
        triggerInboundId,
      });

      if (decision.status !== "reconciled") return decision;

      // Bus-level dedup via the shared `buildConversationErroredEvent`
      // helper — both this reconcile and `handle-message`'s `onFailure`
      // funnel through it, so the `id: errored-${runId}` is identical and
      // Inngest dedups whichever event arrives second.
      // `recover-conversation` runs exactly once per failed run.
      await step.sendEvent(
        "emit-errored",
        buildConversationErroredEvent({
          conversationId: decision.conversationId,
          runId: decision.runId,
          triggerInboundId: decision.triggerInboundId,
          // `errorClass: "WorkerDeath"` distinguishes this path from
          // `onFailure`'s typical `NonRetriableError`. **Best-effort
          // under bus race.** Both emitters land on the bus on a normal
          // `NonRetriableError` failure (onFailure + the system event
          // both fire); whichever arrives first wins dedup. If the
          // reconcile wins, `recover-conversation` sees "WorkerDeath"
          // even though the real cause was the wrapped provider error.
          // Cooldown writes don't branch on this field, so the
          // mislabel is harmless for the circuit breaker. Downstream
          // consumers that bucket by class (evolution failure-reflector)
          // must cross-check against the structured logs by `runId`.
          // See design/agent-resilience.md → Triggers → "errorClass
          // is best-effort under bus race".
          errorClass: "WorkerDeath",
          causeClass: null,
          errorMessage: `inngest run terminated abnormally (run_id ${decision.runId}, function_id ${decision.functionId}): ${decision.errorMessage}`,
        }),
      );

      log.warn(
        {
          conversationId: decision.conversationId,
          runId: decision.runId,
          functionId: decision.functionId,
          errorMessage,
        },
        "reconcile: emitted conversation/errored from inngest/function.failed",
      );

      return decision;
    },
  );
}
