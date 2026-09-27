import type { Transactor } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";
import { renderTurnContext, type TurnContextInput } from "../turn-context.js";

export interface StoreTurnContextDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

/**
 * Render and store a turn's context; returns the stored row's text (see
 * `insertOrRecoverTurnContext`).
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
