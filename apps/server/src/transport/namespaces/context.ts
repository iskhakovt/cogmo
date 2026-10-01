import type { AgentStore } from "../../agent/store/index.js";
import type { Transactor } from "../../db/index.js";
import type { TransportStore } from "../store/index.js";

/** What every namespace reads through: the channel it is scoped to and the stores behind it. */
export interface TransportContext {
  channelId: string;
  runInTx: Transactor;
  transportStore: TransportStore;
  agentStore: AgentStore;
}

/**
 * Resolve the conversation behind a platform address, checked for caller
 * ownership. Shared by the manual triggers (`/compact`, `/reflect`), which
 * act on "whatever conversation this chat is currently in" rather than on an
 * id the caller names.
 *
 * Identity, session and ownership resolve in one tx so all three see the
 * same snapshot. A conversation owned by someone else reports as
 * `no_session` rather than `access_denied`: from the caller's side the two
 * are indistinguishable, and mirroring `getCurrent`'s "you have nothing
 * here" affordance keeps a probing client from learning the address is live.
 */
export async function resolveOwnedConversation(
  ctx: TransportContext,
  platformUserHandle: string,
  platformAddress: string,
): Promise<
  { kind: "identity_rejected" } | { kind: "no_session" } | { kind: "ok"; conversationId: string }
> {
  const { channelId, runInTx, transportStore, agentStore } = ctx;
  return runInTx(async (tx) => {
    const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
    if (!identity) return { kind: "identity_rejected" as const };
    const session = await transportStore.resolveSession(tx, channelId, platformAddress);
    if (!session) return { kind: "no_session" as const };
    const conv = await agentStore.getConversation(tx, session.conversationId);
    if (!conv || conv.userId !== identity.userId) return { kind: "no_session" as const };
    return { kind: "ok" as const, conversationId: conv.id };
  });
}
