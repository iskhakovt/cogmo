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
      // One statement on the address: no lookup for a concurrent swap to go stale against.
      await runInTx((tx) => transportStore.closeActiveSession(tx, channelId, platformAddress));
    },
  };
}
