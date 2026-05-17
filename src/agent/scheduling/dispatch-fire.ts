/**
 * Use case: dispatch a scheduled-task fire onto a conversation.
 *
 * Composes the agent store (most-recent conversation lookup, conversation
 * creation) with the transport store (reachable channels, session swap,
 * synthetic inbound) inside one transaction. Picks one of two paths:
 *
 *   - **Engaged conversation** (last message within `idleTimeoutMs`): the
 *     fire lands on the existing conversation as a synthetic inbound. The
 *     user is mid-conversation; we don't rotate them off it.
 *
 *   - **Idle conversation, or no prior conversation**: rotate. Find every
 *     reachable channel for `(userId, profileId)`, create a fresh
 *     conversation, `swapSession` each reachable address onto it, then
 *     persist the synthetic inbound. Same shape as `/new` + first inbound.
 *
 * If there are no reachable channels (and no engaged conversation),
 * returns `{ status: "skipped", reason: "no_reachable_channel" }`. The
 * scheduled-fires queue (todo: P3) will hand these to a deferred-delivery
 * surface later; for now they no-op.
 */

import type { Transaction, Transactor } from "../../db/index.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { AgentStore } from "../store/index.js";

export interface DispatchScheduledFireDeps {
  runInTx: Transactor;
  agentStore: Pick<AgentStore, "findMostRecentConversationForUserProfile" | "createConversation">;
  transportStore: Pick<
    TransportStore,
    "findReachableChannelsForUserProfile" | "swapSession" | "persistInbound"
  >;
  idleTimeoutMs: number;
}

export interface DispatchScheduledFireArgs {
  userId: string;
  profileId: string;
  scheduledFor: string;
  prompt: string;
}

export type DispatchScheduledFireResult =
  | { status: "dispatched"; conversationId: string; inboundId: string }
  | { status: "skipped"; reason: "no_reachable_channel" };

export async function dispatchScheduledFire(
  deps: DispatchScheduledFireDeps,
  args: DispatchScheduledFireArgs,
): Promise<DispatchScheduledFireResult> {
  return deps.runInTx(async (tx) => {
    const conv = await deps.agentStore.findMostRecentConversationForUserProfile(
      tx,
      args.userId,
      args.profileId,
    );

    const targetConversationId =
      conv?.lastMessageAt != null && Date.now() - conv.lastMessageAt.getTime() < deps.idleTimeoutMs
        ? conv.id
        : await rotateAndCreateConversation(tx, deps, args);

    if (targetConversationId == null) {
      return { status: "skipped" as const, reason: "no_reachable_channel" as const };
    }

    const inbound = await deps.transportStore.persistInbound(tx, {
      channelSessionId: null,
      conversationId: targetConversationId,
      content: buildSyntheticInboundContent(args.scheduledFor, args.prompt),
      platformTs: new Date(args.scheduledFor),
      source: "scheduled",
    });

    return {
      status: "dispatched" as const,
      conversationId: targetConversationId,
      inboundId: inbound.id,
    };
  });
}

async function rotateAndCreateConversation(
  tx: Transaction,
  deps: DispatchScheduledFireDeps,
  args: DispatchScheduledFireArgs,
): Promise<string | null> {
  const channels = await deps.transportStore.findReachableChannelsForUserProfile(
    tx,
    args.userId,
    args.profileId,
  );
  if (channels.length === 0) return null;

  const newConv = await deps.agentStore.createConversation(tx, {
    userId: args.userId,
    profileId: args.profileId,
    isPrivate: true,
  });

  for (const ch of channels) {
    await deps.transportStore.swapSession(tx, ch.channelId, ch.platformAddress, {
      conversationId: newConv.id,
      status: "active",
      receive: ch.receive,
    });
  }

  return newConv.id;
}

/**
 * Build the user-role content for a synthetic inbound: a one-line header
 * carrying the scheduled-for timestamp, then a blank line, then the
 * original prompt. Exported so tests can lock the format and the
 * `register_task` tool's preview can render the same shape.
 */
export function buildSyntheticInboundContent(scheduledFor: string, prompt: string): string {
  return `[Scheduled task — fire time was ${scheduledFor}]\n\n${prompt}`;
}
