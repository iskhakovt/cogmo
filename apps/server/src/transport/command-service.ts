import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
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
        const outcome = await transportStore.closeSession(tx, session.id);
        // The lookup and the close share a snapshot, so only `closed` is
        // expected; the other outcomes leave the same state and are logged.
        match(outcome)
          .with({ kind: "closed" }, () => undefined)
          .with({ kind: "stale" }, ({ status }) =>
            logger.warn({ sessionId: session.id, status }, "reset found the session not active"),
          )
          .with({ kind: "not_found" }, () =>
            logger.warn({ sessionId: session.id }, "reset found no session row"),
          )
          .exhaustive();
      });
    },
  };
}
