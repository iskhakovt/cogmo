import type { Transaction } from "../../db/index.js";
import type { ReachableChannel, TransportStore } from "../store/index.js";

export interface RotateSessionsDeps {
  transportStore: Pick<TransportStore, "swapSession">;
}

export interface RotateSessionsArgs {
  /** A conversation the caller opened in this transaction for the same user and profile. */
  conversationId: string;
  /** `findReachableChannelsForUserProfile` for that user and profile. */
  channels: ReadonlyArray<Pick<ReachableChannel, "channelId" | "platformAddress" | "receive">>;
}

/**
 * The `rotate` transition (design/transport/sessions.md → Lifecycle): swap
 * every reachable channel of a user+profile onto a conversation the caller
 * just created for them, keeping each channel's `receive` mode. No ownership
 * check — the caller created the conversation for that user — and no
 * identity: a scheduled fire or a pipeline start acts on its own behalf.
 */
export async function rotateSessions(
  deps: RotateSessionsDeps,
  tx: Transaction,
  args: RotateSessionsArgs,
): Promise<void> {
  for (const ch of args.channels) {
    await deps.transportStore.swapSession(tx, ch.channelId, ch.platformAddress, {
      conversationId: args.conversationId,
      receive: ch.receive,
    });
  }
}
