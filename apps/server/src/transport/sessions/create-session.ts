import type { AgentStore } from "../../agent/store/index.js";
import type { Transaction } from "../../db/index.js";
import type { Session, TransportStore } from "../store/index.js";
import type { ChannelSessionReceive } from "../store/schema.js";
import { type OpenConversationDeps, openConversation } from "./open-conversation.js";

export interface CreateSessionDeps extends OpenConversationDeps {
  transportStore: Pick<TransportStore, "getChatDefaultProfile" | "resolveSession" | "swapSession">;
  agentStore: Pick<AgentStore, "createConversation" | "getProfile" | "getConversation">;
}

export interface CreateSessionArgs {
  channelId: string;
  platformAddress: string;
  userId: string;
  isPrivate: boolean;
  profileId: string | undefined;
  defaultProfileId: string;
  receive: ChannelSessionReceive;
}

export interface OpenedSession extends Session {
  profileName: string;
  /** `joined`: the address already held an active session, returned as is — `isPrivate` and `profileId` did not apply. */
  kind: "created" | "joined";
}

/**
 * The `create` transition (design/transport/sessions.md → Lifecycle): open a
 * fresh conversation and the address's active session, unless the address
 * holds one — then that session is joined. Two creates racing on an address
 * converge: the second's insert conflicts with the first's committed row,
 * `40001` retries the caller's transaction, and this lookup finds the row.
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
    if (!profile)
      throw new Error(`session ${active.id}: its conversation's profile row is missing`);
    return { ...active, profileName: profile.name, kind: "joined" };
  }
  const opened = await openConversation(deps, tx, args);
  const swapped = await transportStore.swapSession(tx, args.channelId, args.platformAddress, {
    conversationId: opened.conversationId,
    receive: args.receive,
  });
  return {
    id: swapped.id,
    channelId: args.channelId,
    platformAddress: args.platformAddress,
    conversationId: opened.conversationId,
    status: "active",
    receive: args.receive,
    profileName: opened.profileName,
    kind: "created",
  };
}
