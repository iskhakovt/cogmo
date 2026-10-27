import type { DefinedEvent, Durable } from "../../inngest/durable.js";
import { debounceIdle, debounceMaxwait, inboundReady } from "../../inngest/events.js";

export interface RouteInboundArgs {
  conversationId: string;
  inboundMessageId: string;
  /** 0 = no idle timer. */
  idleTimeoutMs: number;
  /** 0 = no maxwait timer. */
  maxWaitMs: number;
}

/**
 * The timer-based debounce router's run: start an idle timer and a maxwait
 * timer for the inbound, whichever are configured, or emit `inbound/ready`
 * at once when neither is. One `route` step carries every emit.
 */
export async function routeInbound(
  step: Pick<Durable, "sendEvent">,
  args: RouteInboundArgs,
): Promise<{ mode: "legacy"; emitted: string[] }> {
  const { conversationId, inboundMessageId, idleTimeoutMs, maxWaitMs } = args;
  const timers: DefinedEvent[] = [
    ...(idleTimeoutMs > 0
      ? [debounceIdle.create({ conversationId, inboundMessageId, timeoutMs: idleTimeoutMs })]
      : []),
    ...(maxWaitMs > 0
      ? [debounceMaxwait.create({ conversationId, inboundMessageId, timeoutMs: maxWaitMs })]
      : []),
  ];
  const events =
    timers.length > 0
      ? timers
      : [inboundReady.create({ conversationId, triggerInboundId: inboundMessageId })];

  await step.sendEvent("route", events);
  return { mode: "legacy", emitted: events.map((e) => e.name) };
}
