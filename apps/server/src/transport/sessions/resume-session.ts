import { err, ok, type Result } from "neverthrow";
import type { AgentStore } from "../../agent/store/index.js";
import type { Transaction } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { Session, TransportStore } from "../store/index.js";
import type { ChannelSessionReceive } from "../store/schema.js";

export interface ResumeSessionDeps {
  transportStore: Pick<TransportStore, "swapSession">;
  agentStore: Pick<AgentStore, "getConversation">;
}

export interface ResumeSessionArgs {
  channelId: string;
  platformAddress: string;
  /** The caller; the conversation must be theirs. */
  userId: string;
  conversationId: string;
  receive: ChannelSessionReceive;
}

export type ResumeSessionError =
  | { code: "conversation_not_found" }
  | { code: "access_denied"; reason: string };

/**
 * The `resume` transition (design/transport/sessions.md → Lifecycle): swap
 * the address onto an existing private conversation of the caller's,
 * closing whatever was active there — `/resume`, the Web UI's stream open,
 * and a boundary hold resolved as resume.
 */
export async function resumeSession(
  deps: ResumeSessionDeps,
  tx: Transaction,
  args: ResumeSessionArgs,
): Promise<Result<Session, ResumeSessionError>> {
  const conv = await deps.agentStore.getConversation(tx, args.conversationId);
  if (!conv) return err({ code: "conversation_not_found" });
  if (conv.userId !== args.userId) {
    return err({ code: "access_denied", reason: "conversation not owned by caller" });
  }
  if (!conv.isPrivate) {
    return err({ code: "access_denied", reason: "cannot resume non-private conversation" });
  }
  const swapped = await deps.transportStore.swapSession(tx, args.channelId, args.platformAddress, {
    conversationId: conv.id,
    receive: args.receive,
  });
  if (swapped.closedIds.length > 0) {
    logger.info(
      {
        platformAddress: args.platformAddress,
        sessionId: swapped.id,
        closedSessionIds: swapped.closedIds,
      },
      "resume closed the address's active session",
    );
  }
  return ok({
    id: swapped.id,
    channelId: args.channelId,
    platformAddress: args.platformAddress,
    conversationId: conv.id,
    status: "active",
    receive: args.receive,
  });
}
