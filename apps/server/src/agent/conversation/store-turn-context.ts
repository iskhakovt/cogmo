import type { Transactor } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";
import { renderTurnContext, type TurnContext, type TurnContextInput } from "../turn-context.js";

export interface StoreTurnContextDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

/**
 * Render and store a turn's context, recording the blocks
 * `coreMemoryUpdates` announces; returns the stored row's text (see
 * `insertOrRecoverTurnContext`).
 */
export async function storeTurnContext(
  deps: StoreTurnContextDeps,
  args: Omit<TurnContextInput, "context"> & {
    /** The turn-starting user row the context leads. */
    messageId: string;
    context: Omit<TurnContext, "announcedCoreMemoryBlocks">;
  },
): Promise<string> {
  const context: TurnContext = {
    ...args.context,
    announcedCoreMemoryBlocks: args.coreMemoryUpdates.blocks.map(({ profileClass, key }) => ({
      profileClass,
      key,
    })),
  };
  const stored = await deps.runInTx((tx) =>
    deps.agentStore.insertOrRecoverTurnContext(tx, {
      messageId: args.messageId,
      rendered: renderTurnContext({ ...args, context }),
      context,
    }),
  );
  return stored.rendered;
}
