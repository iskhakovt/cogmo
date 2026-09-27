import type { Transaction, Transactor } from "../../db/index.js";
import type { TransportStore } from "../../transport/store/index.js";
import { type CoreMemoryScope, type CoreMemoryView, readCoreMemory } from "../core-memory/scope.js";
import type { AgentStore } from "../store/index.js";
import { coreMemoryToAnnounce } from "../system-prompt-snapshot.js";
import { NO_CORE_MEMORY_UPDATES, renderTurnContext } from "../turn-context.js";

export interface StoreTurnContextDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: Pick<TransportStore, "getActiveChannelTypes">;
}

export interface StoreTurnContextArgs {
  conversationId: string;
  /** The turn-starting user row the context leads. */
  messageId: string;
  handledAt: Date;
  timezone: string;
  /** The memories the block shows, already deduplicated. */
  recalledMemories: ReadonlyArray<string>;
  voiceMode: boolean;
  /**
   * The epoch whose snapshot the turn sends, whose core-memory changes the
   * block announces; null for a turn that sends no snapshot.
   */
  epoch: {
    userId: string;
    coreMemoryScope: CoreMemoryScope;
    openedBy: string;
    openedAt: Date;
  } | null;
}

/**
 * Render and store a turn's context, reading in one transaction the channels
 * the conversation's sessions deliver to and, for a turn on a snapshot, the
 * core memory to announce; returns the stored row's text (see
 * `insertOrRecoverTurnContext`).
 */
export async function storeTurnContext(
  deps: StoreTurnContextDeps,
  args: StoreTurnContextArgs,
): Promise<string> {
  const stored = await deps.runInTx(async (tx) => {
    const channelTypes = (
      await deps.transportStore.getActiveChannelTypes(tx, args.conversationId)
    ).toSorted();
    const coreMemoryUpdates = await coreMemoryUpdatesFor(tx, deps.agentStore, args);
    const context = {
      recalledMemories: [...args.recalledMemories],
      voiceMode: args.voiceMode,
      channelTypes,
      announcedCoreMemoryBlocks: coreMemoryUpdates.blocks.map(({ profileClass, key }) => ({
        profileClass,
        key,
      })),
    };
    return deps.agentStore.insertOrRecoverTurnContext(tx, {
      messageId: args.messageId,
      rendered: renderTurnContext({
        handledAt: args.handledAt,
        timezone: args.timezone,
        context,
        coreMemoryUpdates,
      }),
      context,
    });
  });
  return stored.rendered;
}

async function coreMemoryUpdatesFor(
  tx: Transaction,
  agentStore: AgentStore,
  { conversationId, epoch }: StoreTurnContextArgs,
): Promise<CoreMemoryView> {
  if (epoch === null) return NO_CORE_MEMORY_UPDATES;
  return coreMemoryToAnnounce({
    view: await readCoreMemory(tx, agentStore, epoch.userId, epoch.coreMemoryScope),
    updateTimes: await agentStore.getCoreMemoryUpdateTimes(tx, epoch.userId),
    epochOpenedAt: epoch.openedAt,
    announcements: await agentStore.listCoreMemoryAnnouncements(tx, conversationId, epoch.openedBy),
  });
}
