/**
 * Fire handler for `agent/scheduled-task.fire`. Persists a synthetic
 * inbound message into the user's most recently active conversation for
 * the task's profile and emits `inbound/arrived` — the existing
 * debounce + handle-message pipeline picks it up unchanged.
 *
 * Routing:
 *   - "Most recently active session" for (userId, profileId) wins.
 *     Lookup via `transportStore.findActiveSessionForUserProfile`.
 *   - If the user has no active session on that profile, the fire is
 *     skipped (logged as warn, no event emitted). Future tightening:
 *     surface "fire dropped because you were offline" the next time the
 *     user opens a chat. For now, an offline user just misses the fire.
 *
 * Content shape:
 *   The synthetic inbound is plain text with a header line carrying the
 *   row's scheduled-for timestamp, so the model sees it explicitly in
 *   the user-role message body:
 *
 *     [Scheduled task — fire time was 2026-05-14T09:00:00Z]
 *
 *     <original prompt>
 *
 *   The fire handler intentionally does NOT inject a "now" timestamp:
 *   the model gets current time from the system prompt's date header
 *   (added downstream), and including `now` here would drift on Inngest
 *   retries (the same fire would carry different "now"s, breaking
 *   replay determinism).
 *
 * Reuses the existing pipeline (debounce → handle-message → delivery),
 * so streaming UX, voice mode, tool gating, and error handling all
 * apply for free.
 *
 * See design/scheduling.md → Agent Self-Scheduling.
 */

import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { inboundArrived, scheduledTaskFire } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { TransportStore } from "../../transport/store/index.js";

const log = logger.child({ component: "scheduling.fire-handler" });

export interface ScheduledTaskFireDeps {
  runInTx: Transactor;
  transportStore: Pick<TransportStore, "findActiveSessionForUserProfile" | "persistInbound">;
}

export function createScheduledTaskFireHandler(deps: ScheduledTaskFireDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "scheduled-task-fire",
      // 2 retries on the synthetic-inbound persistence path. The actual
      // agent turn runs in handle-message, which owns its own retry
      // budget; we just retry the lookup-and-persist if the DB blips.
      retries: 2,
      // Singleton per-task — a ticker retry that re-emits the same fire
      // is already idempotent at Inngest's event-id dedup
      // (`${taskId}:${scheduledFor}`), but in the rare overlap a second
      // run might race the first's `persistInbound`. Concurrency 1 per
      // task closes that gap cheaply.
      concurrency: { limit: 1, key: "event.data.taskId" },
      triggers: [scheduledTaskFire],
    },
    async ({ event, step }) => {
      const { taskId, userId, profileId, scheduledFor, prompt } = event.data;

      const target = await step.run("find-active-session", () =>
        deps.runInTx((tx) =>
          deps.transportStore.findActiveSessionForUserProfile(tx, userId, profileId),
        ),
      );
      if (!target) {
        log.warn(
          { taskId, userId, profileId, scheduledFor },
          "scheduled fire: user has no active session for profile — skipping",
        );
        return { status: "skipped" as const, reason: "no_active_session" as const };
      }

      const content = buildSyntheticInboundContent(scheduledFor, prompt);

      // platform_ts marks "when the user sent it" — for synthetic fires,
      // that's the scheduled-for timestamp (the row's original fire time),
      // NOT now(). This way the debounce + history layers see the fire
      // ordered by its scheduled instant, not by when the ticker happened
      // to dispatch it. Late fires don't appear to arrive "out of order"
      // for compaction or audit.
      const inbound = await step.run("persist-inbound", () =>
        deps.runInTx((tx) =>
          deps.transportStore.persistInbound(tx, {
            channelSessionId: target.sessionId,
            conversationId: target.conversationId,
            content,
            platformTs: new Date(scheduledFor),
          }),
        ),
      );

      await step.sendEvent(
        "trigger-handle-message",
        inboundArrived.create({
          conversationId: target.conversationId,
          inboundMessageId: inbound.id,
        }),
      );

      log.info(
        { taskId, conversationId: target.conversationId, inboundId: inbound.id },
        "scheduled fire dispatched",
      );
      return {
        status: "dispatched" as const,
        conversationId: target.conversationId,
        inboundId: inbound.id,
      };
    },
  );
}

/**
 * Build the user-role content for a synthetic inbound: a one-line header
 * carrying the scheduled-for timestamp, then a blank line, then the
 * original prompt. Exported so tests can lock the format and the
 * `register_task` tool's preview can render the same shape.
 */
export function buildSyntheticInboundContent(scheduledFor: string, prompt: string): string {
  return `[Scheduled task — fire time was ${scheduledFor}]\n\n${prompt}`;
}
