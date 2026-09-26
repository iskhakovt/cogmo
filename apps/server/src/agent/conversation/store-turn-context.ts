import type { Transactor } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";
import { renderTurnContext, type TurnContextInput } from "../turn-context.js";

export interface StoreTurnContextDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

/**
 * Render a turn's context and store it against the turn's user message,
 * returning the text the turn sends: the stored row's, so a retry after a
 * committed insert sends what the first attempt stored and later turns load.
 */
export async function storeTurnContext(
  deps: StoreTurnContextDeps,
  args: TurnContextInput & { messageId: string },
): Promise<string> {
  const stored = await deps.runInTx((tx) =>
    deps.agentStore.insertOrRecoverTurnContext(tx, {
      messageId: args.messageId,
      rendered: renderTurnContext(args),
      context: args.context,
    }),
  );
  return stored.rendered;
}
