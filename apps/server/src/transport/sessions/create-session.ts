import type { AgentStore } from "../../agent/store/index.js";
import type { Transaction } from "../../db/index.js";
import type { Session, TransportStore } from "../store/index.js";
import type { ChannelSessionReceive } from "../store/schema.js";
import { type OpenConversationDeps, openConversation } from "./open-conversation.js";

export interface CreateSessionDeps extends OpenConversationDeps {
  transportStore: Pick<TransportStore, "getChatDefaultProfile" | "resolveSession" | "swapSession">;
  agentStore: Pick<AgentStore, "createConversation" | "getProfile" | "getConversation">;
}

/**
 * No explicit profile: the join path returns the address's session as is, so
 * a caller with a profile to apply supersedes instead.
 */
export interface CreateSessionArgs {
  channelId: string;
  platformAddress: string;
  userId: string;
  isPrivate: boolean;
  defaultProfileId: string;
  receive: ChannelSessionReceive;
}

export interface OpenedSession extends Session {
  profileName: string;
}

/**
 * The `create` transition (design/transport/sessions.md → Lifecycle): open a
 * fresh conversation and the address's active session, unless the address
 * holds one — then that session is returned, and `isPrivate` did not apply.
 * Two creates racing on an address converge: the second's insert conflicts
 * with the first's committed row, `40001` retries the caller's transaction,
 * and this lookup finds the row.
 */
export async function createSession(
  deps: CreateSessionDeps,
  tx: Transaction,
  args: CreateSessionArgs,
): Promise<OpenedSession> {
  const { transportStore, agentStore } = deps;
  const active = await transportStore.resolveSession(tx, args.channelId, args.platformAddress);
  if (active) {
    // Foreign keys from a row this transaction can see guarantee both reads.
    const conv = await agentStore.getConversation(tx, active.conversationId);
    const profile = conv ? await agentStore.getProfile(tx, conv.profileId) : null;
    if (!profile) {
      throw new Error(`session ${active.id}: its conversation's profile row is missing`);
    }
    return { ...active, profileName: profile.name };
  }
  const opened = await openConversation(deps, tx, { ...args, profileId: undefined });
  const swapped = await transportStore.swapSession(tx, args.channelId, args.platformAddress, {
    conversationId: opened.conversationId,
    receive: args.receive,
  });
  return { ...swapped.session, profileName: opened.profileName };
}
