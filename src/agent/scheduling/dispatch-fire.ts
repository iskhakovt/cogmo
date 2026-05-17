/**
 * Dispatch a scheduled-task fire onto a conversation. Engaged conversation
 * (last message within `idleTimeoutMs`) → reuse. Idle, or no prior
 * conversation → rotate every reachable channel onto a fresh conversation
 * (same shape as `/new` + first inbound). No reachable channel → skip.
 *
 * Idempotent on `scheduledFireKey` (`${taskId}:${scheduledFor}`): a retry
 * after a successful tx commit short-circuits to the existing inbound
 * instead of double-creating a rotated conversation.
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
    | "findReachableChannelsForUserProfile"
    | "findInboundByScheduledFireKey"
    | "swapSession"
    | "persistInbound"
  >;
  idleTimeoutMs: number;
}

export interface DispatchScheduledFireArgs {
  userId: string;
  profileId: string;
  scheduledFor: string;
  prompt: string;
  /** `${taskId}:${scheduledFor}` — same shape as the Inngest event id. */
  scheduledFireKey: string;
}

export type DispatchScheduledFireResult =
  | { status: "dispatched"; conversationId: string; inboundId: string }
  | { status: "skipped"; reason: "no_reachable_channel" };

export async function dispatchScheduledFire(
  deps: DispatchScheduledFireDeps,
  args: DispatchScheduledFireArgs,
): Promise<DispatchScheduledFireResult> {
  return deps.runInTx(async (tx) => {
    // Retry-after-commit guard: if a prior attempt committed and Inngest
    // didn't get the step ack, the inbound row is already there. Reuse
    // its ids so the downstream `inbound/arrived` event id (and the
    // pipeline state below it) stays stable.
    const existing = await deps.transportStore.findInboundByScheduledFireKey(
      tx,
      args.scheduledFireKey,
    );
    if (existing) {
      return {
        status: "dispatched" as const,
        conversationId: existing.conversationId,
        inboundId: existing.id,
      };
    }

    const conv = await deps.agentStore.findMostRecentConversationForUserProfile(
      tx,
      args.userId,
      args.profileId,
    );

    // Reuse the most-recent conversation when the user is engaged OR
    // when it has no messages yet (e.g. they `/new`'d on this profile
    // and haven't typed). Empty conversations are explicitly opened —
    // landing the fire there matches "I opened a thread, then this
    // reminder appeared," and avoids stranding the empty row when
    // rotation would otherwise produce a sibling fresh conversation.
    const reuse =
      conv != null &&
      (conv.lastMessageAt == null ||
        Date.now() - conv.lastMessageAt.getTime() < deps.idleTimeoutMs);

    const targetConversationId = reuse
      ? conv.id
      : await rotateAndCreateConversation(tx, deps, args);

    if (targetConversationId == null) {
      return { status: "skipped" as const, reason: "no_reachable_channel" as const };
    }

    const inbound = await deps.transportStore.persistInbound(tx, {
      source: "scheduled",
      scheduledFireKey: args.scheduledFireKey,
      conversationId: targetConversationId,
      content: buildSyntheticInboundContent(args.scheduledFor, args.prompt),
      platformTs: new Date(args.scheduledFor),
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
