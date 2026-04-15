import { inngest } from "../inngest/client.js";
import {
  debounceCancel,
  debounceIdle,
  debounceMaxwait,
  inboundArrived,
  inboundReady,
} from "../inngest/events.js";
import { debounceWaitMs } from "../metrics.js";

export interface DebounceConfig {
  idleTimeoutMs: number; // 0 = disabled
  maxWaitMs: number; // 0 = disabled
  resumePolicy: "debounce" | "flush" | "await_input";
}

/**
 * Create debounce Inngest functions.
 *
 * - debounce-router: listens to inbound/arrived, emits debounce timers or inbound/ready
 * - debounce-idle: sleeps, cancelled by next message (resets timer)
 * - debounce-maxwait: sleeps, hard deadline (only cancelled by debounce/cancel)
 *
 * When both timeouts are 0, the router emits inbound/ready directly (no debounce).
 */
export function createDebounceFunctions(config: DebounceConfig) {
  const router = inngest.createFunction(
    { id: "debounce-router", triggers: [inboundArrived] },
    async ({ event, step }) => {
      const { conversationId, inboundMessageId } = event.data;
      // biome-ignore lint/suspicious/noExplicitAny: Inngest event types vary
      const events: any[] = [];

      if (config.idleTimeoutMs > 0) {
        events.push(
          debounceIdle.create({
            conversationId,
            inboundMessageId,
            timeoutMs: config.idleTimeoutMs,
          }),
        );
      }
      if (config.maxWaitMs > 0) {
        events.push(
          debounceMaxwait.create({
            conversationId,
            inboundMessageId,
            timeoutMs: config.maxWaitMs,
          }),
        );
      }

      // No debounce configured — fire immediately
      if (events.length === 0) {
        events.push(inboundReady.create({ conversationId, triggerInboundId: inboundMessageId }));
      }

      await step.sendEvent("route", events);
      return { emitted: events.map((e) => e.name) };
    },
  );

  // Idle timer: cancelled by next debounce/idle (same conversation) — resets on each message.
  const idle = inngest.createFunction(
    {
      id: "debounce-idle",
      triggers: [debounceIdle],
      cancelOn: [
        { event: debounceIdle, match: "data.conversationId" },
        { event: debounceCancel, match: "data.conversationId" },
      ],
    },
    async ({ event, step }) => {
      const ms = event.data.timeoutMs;
      await step.sleep("wait", ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);
      debounceWaitMs.record(ms, { kind: "idle" });
      await step.sendEvent(
        "fire",
        inboundReady.create({
          conversationId: event.data.conversationId,
          triggerInboundId: event.data.inboundMessageId,
        }),
      );
    },
  );

  // Maxwait timer: NOT cancelled by new messages — only by debounce/cancel.
  // Every message gets its own maxwait timer. Stale ones are rejected by the orchestrator.
  const maxwait = inngest.createFunction(
    {
      id: "debounce-maxwait",
      triggers: [debounceMaxwait],
      cancelOn: [{ event: debounceCancel, match: "data.conversationId" }],
    },
    async ({ event, step }) => {
      const ms = event.data.timeoutMs;
      await step.sleep("wait", ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);
      debounceWaitMs.record(ms, { kind: "maxwait" });
      await step.sendEvent(
        "fire",
        inboundReady.create({
          conversationId: event.data.conversationId,
          triggerInboundId: event.data.inboundMessageId,
        }),
      );
    },
  );

  return [router, idle, maxwait];
}
