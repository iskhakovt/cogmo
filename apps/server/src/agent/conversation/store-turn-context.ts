import type { Transactor } from "../../db/index.js";
import type { CoreMemoryScope } from "../core-memory/scope.js";
import type { AgentStore } from "../store/index.js";
import type { CoreMemoryChange } from "../system-prompt-snapshot.js";
import { renderTurnContext, type TurnContext, type TurnContextInput } from "../turn-context.js";

export interface StoreTurnContextDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

/**
 * Render and store a turn's context, recording each block
 * `coreMemoryUpdates` announces with the version it shows; returns the stored
 * row's text (see `insertOrRecoverTurnContext`).
 */
export async function storeTurnContext(
  deps: StoreTurnContextDeps,
  args: Omit<TurnContextInput, "context" | "coreMemoryUpdates"> & {
    /** The turn-starting user row the context leads. */
    messageId: string;
    context: Omit<TurnContext, "announcedCoreMemoryBlocks">;
    coreMemoryUpdates: { scope: CoreMemoryScope; blocks: ReadonlyArray<CoreMemoryChange> };
  },
): Promise<string> {
  const context: TurnContext = {
    ...args.context,
    announcedCoreMemoryBlocks: args.coreMemoryUpdates.blocks.map(
      ({ profileClass, key, updatedAt }) => ({ profileClass, key, updatedAt }),
    ),
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
