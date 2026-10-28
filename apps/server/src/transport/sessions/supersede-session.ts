import type { Transaction } from "../../db/index.js";
import type { Session, TransportStore } from "../store/index.js";
import type { ChannelSessionReceive } from "../store/schema.js";
import { type OpenConversationDeps, openConversation } from "./open-conversation.js";

export interface SupersedeSessionDeps extends OpenConversationDeps {
  transportStore: Pick<TransportStore, "getChatDefaultProfile" | "swapSession">;
}

export interface SupersedeSessionArgs {
  channelId: string;
  platformAddress: string;
  userId: string;
  isPrivate: boolean;
  profileId: string | undefined;
  defaultProfileId: string;
  receive: ChannelSessionReceive;
}

export interface SupersededSession {
  session: Session & { profileName: string };
  /** The active session the address held, if any. */
  closedIds: ReadonlyArray<string>;
}

/**
 * The `supersede` transition (design/transport/sessions.md → Lifecycle):
 * open a fresh conversation and swap the address onto it, closing whatever
 * was active there — `/new`, and a boundary hold resolved as fresh.
 */
export async function supersedeSession(
  deps: SupersedeSessionDeps,
  tx: Transaction,
  args: SupersedeSessionArgs,
): Promise<SupersededSession> {
  const opened = await openConversation(deps, tx, args);
  const swapped = await deps.transportStore.swapSession(tx, args.channelId, args.platformAddress, {
    conversationId: opened.conversationId,
    receive: args.receive,
  });
  return {
    session: {
      id: swapped.id,
      channelId: args.channelId,
      platformAddress: args.platformAddress,
      conversationId: opened.conversationId,
      status: "active",
      receive: args.receive,
      profileName: opened.profileName,
    },
    closedIds: swapped.closedIds,
  };
}
