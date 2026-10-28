import type { Durable } from "../../inngest/durable.js";
import { inboundReady } from "../../inngest/events.js";
import { debounceWaitMs } from "../../metrics.js";

export interface EmitNativeReadyArgs {
  conversationId: string;
  /** The last `inbound/arrived` of the burst: Inngest's native debounce hands the router only that one. */
  inboundMessageId: string;
  /** That event's `ts`, when the event carries one. */
  triggeredAt: number | undefined;
}

/**
 * The native debounce router's run: the burst has gone quiet, so emit one
 * `inbound/ready` for it. The orchestrator loads every unbatched inbound row
 * from the DB, so the last event's id is the only one it needs.
 *
 * Native debounce exposes no internal timing, so the wait sample is a proxy:
 * time from the burst's last event to the emit.
 */
export async function emitNativeReady(
  step: Pick<Durable, "run" | "sendEvent">,
  args: EmitNativeReadyArgs,
): Promise<{ mode: "native"; triggerInboundId: string }> {
  const { conversationId, inboundMessageId, triggeredAt } = args;
  await step.sendEvent(
    "ready",
    inboundReady.create({ conversationId, triggerInboundId: inboundMessageId }),
  );
  if (triggeredAt !== undefined) {
    await step.run("record-wait", async () => {
      debounceWaitMs.record(Math.max(0, Date.now() - triggeredAt), { kind: "native" });
    });
  }
  return { mode: "native", triggerInboundId: inboundMessageId };
}
