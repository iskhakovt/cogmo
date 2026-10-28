import type { AgentStore } from "../../agent/store/index.js";
import type { Transaction } from "../../db/index.js";
import type { TransportStore } from "../store/index.js";

export interface OpenConversationDeps {
  transportStore: Pick<TransportStore, "getChatDefaultProfile">;
  agentStore: Pick<AgentStore, "createConversation" | "getProfile">;
}

export interface OpenConversationArgs {
  channelId: string;
  platformAddress: string;
  userId: string;
  isPrivate: boolean;
  /** Explicit profile; else the chat's default, else `defaultProfileId`. */
  profileId: string | undefined;
  defaultProfileId: string;
}

/**
 * Insert a conversation for `userId` under the resolved profile, in the
 * caller's transaction. No session is bound: the session transitions in this
 * folder call it, and the Web UI's new-chat route uses it alone.
 *
 * The per-chat default is set via `/profile default <name>` and persists
 * across `/new`, so a chat can be pinned to a profile without the user
 * re-stating it every time.
 */
export async function openConversation(
  deps: OpenConversationDeps,
  tx: Transaction,
  args: OpenConversationArgs,
): Promise<{ conversationId: string; profileName: string }> {
  const { transportStore, agentStore } = deps;
  let profileId = args.profileId;
  if (!profileId) {
    const chatDefault = await transportStore.getChatDefaultProfile(
      tx,
      args.channelId,
      args.platformAddress,
    );
    profileId = chatDefault?.profileId ?? args.defaultProfileId;
  }
  const conv = await agentStore.createConversation(tx, {
    userId: args.userId,
    profileId,
    isPrivate: args.isPrivate,
  });
  // The insert just succeeded under this profile's foreign key.
  const profile = await agentStore.getProfile(tx, profileId);
  if (!profile) throw new Error(`conversation ${conv.id}: profile ${profileId} row is missing`);
  return { conversationId: conv.id, profileName: profile.name };
}
