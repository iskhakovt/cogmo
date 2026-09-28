import type { TransportStore } from "../../transport/store/index.js";
import {
  type CoreMemoryChange,
  coreMemoryChangesSince,
  type EpochSnapshot,
  epochOf,
} from "../system-prompt-snapshot.js";
import {
  type RenderSystemPromptArgs,
  renderSystemPrompt,
  type SystemPromptDeps,
} from "./render-system-prompt.js";

/** What a chat turn decides its epoch and renders its turn context from; see `continuesEpoch`. */
export interface LoadedSystemPrompt {
  /** The system prompt as it renders now: what an epoch opened by this turn sends. */
  rendered: string;
  configDigest: string;
  /** The conversation's current epoch, or null before its first. */
  snapshot: EpochSnapshot | null;
  /** The channel types of the conversation's active sessions: the turn context's delivery channels. */
  channelTypes: string[];
  /** The blocks the turn sees that changed since `snapshot` read core memory; none without one. */
  coreMemoryChanges: CoreMemoryChange[];
}

/**
 * Render a chat turn's system prompt and load the conversation's current
 * epoch, with the core-memory changes the turn context may announce against
 * it, in one read.
 */
export async function loadSystemPrompt(
  deps: SystemPromptDeps & { transportStore: Pick<TransportStore, "getActiveChannelTypes"> },
  args: RenderSystemPromptArgs & { conversationId: string },
): Promise<LoadedSystemPrompt> {
  return deps.runInTx(async (tx) => {
    const { rendered, configDigest, coreMemory } = await renderSystemPrompt(tx, deps, args);
    const channelTypes = [
      ...(await deps.transportStore.getActiveChannelTypes(tx, args.conversationId)),
    ];
    const latest = await deps.agentStore.getLatestSystemPromptSnapshot(tx, args.conversationId);
    if (latest === undefined) {
      return {
        rendered,
        configDigest,
        snapshot: null,
        channelTypes,
        coreMemoryChanges: [],
      };
    }
    const updateTimes = await deps.agentStore.getCoreMemoryUpdateTimes(tx, args.userId);
    return {
      rendered,
      configDigest,
      snapshot: epochOf(latest),
      channelTypes,
      coreMemoryChanges: coreMemoryChangesSince(coreMemory, updateTimes, latest.createdAt),
    };
  });
}
