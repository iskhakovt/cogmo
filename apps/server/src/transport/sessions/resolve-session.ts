import { match } from "ts-pattern";
import type { AgentStore } from "../../agent/store/index.js";
import type { Transaction } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { Session, TransportStore } from "../store/index.js";

export interface ResolveSessionDeps {
  transportStore: Pick<TransportStore, "resolveSession" | "closeSession">;
  agentStore: Pick<AgentStore, "getLastMessageTime">;
}

export interface ResolveSessionArgs {
  channelId: string;
  platformAddress: string;
  /** Idle window after the conversation's last message; `0` disables rotation. */
  idleTimeoutMs: number;
}

/**
 * The address's active session, or null. A session whose conversation has
 * been quiet past the idle window is closed here (lazy rotation) and null is
 * returned, so the inbound that found it starts a fresh conversation. The
 * lookup, the idle check and the close share the caller's transaction; two
 * inbounds reading the same stale session both end up with null, whichever
 * one's close lands.
 */
export async function resolveSession(
  deps: ResolveSessionDeps,
  tx: Transaction,
  args: ResolveSessionArgs,
): Promise<Session | null> {
  const session = await deps.transportStore.resolveSession(
    tx,
    args.channelId,
    args.platformAddress,
  );
  if (!session) return null;
  if (args.idleTimeoutMs <= 0) return session;

  const lastActivity = await deps.agentStore.getLastMessageTime(tx, session.conversationId);
  if (!lastActivity || Date.now() - lastActivity.getTime() <= args.idleTimeoutMs) {
    return session;
  }
  const fields = { sessionId: session.id, conversationId: session.conversationId };
  match(await deps.transportStore.closeSession(tx, session.id))
    .with({ kind: "closed" }, () =>
      logger.warn(fields, "session idle-expired via safety net (idle timer may have failed)"),
    )
    .with({ kind: "stale" }, { kind: "not_found" }, (missed) =>
      logger.info({ ...fields, ...missed }, "idle session was already closed"),
    )
    .exhaustive();
  return null;
}
