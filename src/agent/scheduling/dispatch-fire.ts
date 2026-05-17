/**
 * Dispatch a scheduled-task fire onto a conversation. Engaged conversation
 * (last message within `idleTimeoutMs`) → reuse. Idle, or no prior
 * conversation → rotate every reachable channel onto a fresh conversation
 * (same shape as `/new` + first inbound). No reachable channel → skip.
 *
 * See design/scheduling.md → Synthetic conversation turn.
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

export function buildSyntheticInboundContent(scheduledFor: string, prompt: string): string {
  return `[Scheduled task — fire time was ${scheduledFor}]\n\n${prompt}`;
}
