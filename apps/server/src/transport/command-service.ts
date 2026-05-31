import type { Transactor } from "../db/index.js";
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
        if (session) {
          await transportStore.closeSession(tx, session.id);
        }
      });
    },
  };
}
