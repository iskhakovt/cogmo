import type { Durable } from "../../inngest/durable.js";
import { inboundReady } from "../../inngest/events.js";
import { debounceWaitMs } from "../../metrics.js";
import { durableSleepMs } from "./durable-sleep.js";

export interface FireDebounceTimerArgs {
  /** Which timer this is, as the wait histogram labels it. */
  kind: "idle" | "maxwait";
  conversationId: string;
  inboundMessageId: string;
  /** The configured wait, before quantisation. */
  timeoutMs: number;
}

/**
 * An idle or maxwait timer's run: sleep out the wait, then emit
 * `inbound/ready` for the inbound that started it. Cancellation is the
 * function's (`cancelOn`), so reaching the emit means no cancel arrived.
 *
 * Sleep and histogram sample share one millisecond value, and it is a whole
 * number of seconds, so "how long did debounce hold this turn" reads the same
 * on the wire as in the metric. A configured duration finer than one second
 * is quantised by {@link durableSleepMs} first — the metric reports the
 * honoured wait, not the requested one.
 */
export async function fireDebounceTimer(
  step: Pick<Durable, "run" | "sendEvent" | "sleep">,
  args: FireDebounceTimerArgs,
): Promise<void> {
  const ms = durableSleepMs(args.timeoutMs);
  await step.sleep("wait", `${ms}ms`);
  await step.sendEvent(
    "fire",
    inboundReady.create({
      conversationId: args.conversationId,
      triggerInboundId: args.inboundMessageId,
    }),
  );
  await step.run("record-wait", async () => {
    debounceWaitMs.record(ms, { kind: args.kind });
  });
}
