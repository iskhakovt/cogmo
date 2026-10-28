import type { Transaction } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { TransportStore } from "../store/index.js";
import type { ChannelSessionReceive } from "../store/schema.js";
import type { OpenedSession } from "./create-session.js";
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

/**
 * The `supersede` transition (design/transport/sessions.md → Lifecycle):
 * open a fresh conversation and swap the address onto it, closing whatever
 * was active there — `/new`, and a boundary hold resolved as fresh. The
 * session it closed is logged: a reply in flight to it is skipped at
 * delivery, and this line is the record of why.
 */
export async function supersedeSession(
  deps: SupersedeSessionDeps,
  tx: Transaction,
  args: SupersedeSessionArgs,
): Promise<OpenedSession> {
  const opened = await openConversation(deps, tx, args);
  const swapped = await deps.transportStore.swapSession(tx, args.channelId, args.platformAddress, {
    conversationId: opened.conversationId,
    receive: args.receive,
  });
  if (swapped.closedIds.length > 0) {
    logger.info(
      {
        platformAddress: args.platformAddress,
        sessionId: swapped.session.id,
        closedSessionIds: swapped.closedIds,
      },
      "supersede closed the address's active session",
    );
  }
  return { ...swapped.session, profileName: opened.profileName };
}
