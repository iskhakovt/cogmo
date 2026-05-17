/**
 * Inngest handler for `agent/scheduled-task.fire`. Composes the
 * `dispatchScheduledFire` use case (engaged-reuse-or-rotate-and-create)
 * with the existing inbound pipeline by emitting `inbound/arrived` once
 * the synthetic inbound is persisted — `handle-message` then runs the
 * agent loop and delivers via `DeliveryRouter` as for any inbound.
 *
 * Crash recovery: the dispatch step is checkpointed; an Inngest retry
 * after the step succeeded replays the cached `{ conversationId,
 * inboundId }` instead of re-running the use case (which would otherwise
 * double-create a rotated conversation). The `inbound/arrived` send is
 * idempotency-keyed by `fire:<inboundId>` so the event bus dedup's an
 * at-least-once delivery.
 *
 * See design/scheduling.md → Synthetic conversation turn and
 * design/transport/sessions.md.
 */

import type { Inngest } from "inngest";
import { inboundArrived, scheduledTaskFire } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import { type DispatchScheduledFireDeps, dispatchScheduledFire } from "./dispatch-fire.js";

const log = logger.child({ component: "scheduling.fire-handler" });

export type ScheduledTaskFireDeps = DispatchScheduledFireDeps;

export function createScheduledTaskFireHandler(deps: ScheduledTaskFireDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "scheduled-task-fire",
      retries: 2,
      // Per-task singleton — the ticker re-emit dedups at the event bus,
      // but in the rare race a second function run might overlap. Keeps
      // dispatch tx isolation simple at single-user scale.
      concurrency: { limit: 1, key: "event.data.taskId" },
      triggers: [scheduledTaskFire],
    },
    async ({ event, step }) => {
      const { taskId, userId, profileId, scheduledFor, prompt } = event.data;

      const result = await step.run("dispatch", () =>
        dispatchScheduledFire(deps, { userId, profileId, scheduledFor, prompt }),
      );

      if (result.status === "skipped") {
        log.warn(
          { taskId, userId, profileId, scheduledFor, reason: result.reason },
          "scheduled fire skipped",
        );
        return result;
      }

      await step.sendEvent("trigger-handle-message", {
        ...inboundArrived.create({
          conversationId: result.conversationId,
          inboundMessageId: result.inboundId,
        }),
        // Idempotency key — Inngest dedup'es events with the same `id`,
        // so an at-least-once double-deliver of this send produces
        // exactly one `inbound/arrived` downstream. `inbound.id` is
        // UUIDv7 from the cached dispatch step, so every retry projects
        // the same value.
        id: `fire:${result.inboundId}`,
      });

      log.info(
        { taskId, conversationId: result.conversationId, inboundId: result.inboundId },
        "scheduled fire dispatched",
      );
      return result;
    },
  );
}

export { buildSyntheticInboundContent } from "./dispatch-fire.js";
