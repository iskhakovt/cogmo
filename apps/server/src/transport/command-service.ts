import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import { missedClose } from "./sessions/close-session.js";
import type { TransportStore } from "./store/index.js";

/**
 * Domain service for control commands — operations that channel adapters
 * execute directly without going through the orchestrator.
 *
 * Reusable across all channel adapters (CLI, Telegram, Slack, etc.).
 */
export interface CommandService {
  resetConversation(channelId: string, platformAddress: string): Promise<void>;
}

export function createCommandService(
  runInTx: Transactor,
  transportStore: TransportStore,
): CommandService {
  return {
    async resetConversation(channelId, platformAddress) {
      await runInTx(async (tx) => {
        const session = await transportStore.resolveSession(tx, channelId, platformAddress);
        if (!session) return;
        // The lookup and the close share a snapshot, so only `closed` is
        // expected; a miss leaves the same state and is logged.
        const missed = missedClose(await transportStore.closeSession(tx, session.id));
        if (missed)
          logger.warn({ sessionId: session.id, ...missed }, "reset found no active session");
      });
    },
  };
}
