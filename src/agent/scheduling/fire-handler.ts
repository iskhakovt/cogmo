/**
 * Inngest handler for `agent/scheduled-task.fire`. Runs the dispatch use
 * case under one durable step, then re-enters the inbound pipeline by
 * emitting `inbound/arrived` — `handle-message` takes it from there.
 *
 * The dispatch step is cached on success; an Inngest retry projects the
 * same `inboundId` so the `fire:<inboundId>` idempotency key on the
 * downstream send dedups at the event bus. Without the cache, a retry
 * after a successful rotation would double-create the fresh conversation.
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
      // Per-task singleton — keeps dispatch tx isolation simple if the
      // ticker's event-bus dedup ever misses and two runs overlap.
      concurrency: { limit: 1, key: "event.data.taskId" },
      triggers: [scheduledTaskFire],
    },
    async ({ event, step }) => {
      const { taskId, userId, profileId, scheduledFor, prompt } = event.data;

      // Same shape as the ticker's event-bus dedup key — the dispatcher
      // uses it to short-circuit a retry that lands after the tx
      // committed but before Inngest got the step ack.
      const scheduledFireKey = `${taskId}:${scheduledFor}`;

      const result = await step.run("dispatch", () =>
        dispatchScheduledFire(deps, {
          userId,
          profileId,
          scheduledFor,
          prompt,
          scheduledFireKey,
        }),
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
