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

export function createCommandService(transportStore: TransportStore): CommandService {
  return {
    async resetConversation(channelId, platformAddress) {
      const session = await transportStore.resolveSession(channelId, platformAddress);
      if (session) {
        await transportStore.closeSession(session.id);
      }
    },
  };
}
