import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { Transaction } from "../../db/index.js";
import type { inboundArrived as InboundArrivedEvent } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { AttachmentStore } from "../attachment-store.js";
import type { InboundContent } from "../content.js";
import type { CloseSessionOutcome, Session } from "../store/index.js";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";

/** The session lifecycle and inbound emission — the chat path every adapter drives. */
export interface TransportSessions {
  /**
   * The active session on `platformAddress`, or null. When the session's
   * conversation has been quiet past the idle window, closes it and returns
   * null — the lookup, the idle check and the close share one transaction.
   */
  resolveSession(platformAddress: string): Promise<Session | null>;

  /**
   * Open a fresh conversation on `platformAddress`, or join the active
   * session already there. The address holds at most one active session, so
   * two opens racing on it converge on one conversation: the second finds
   * the first's row (on its retry, when the first committed after its
   * snapshot) and returns it instead of inserting. A caller that means to
   * supersede the active session closes it first.
   *
   * Returns the session augmented with `profileName` — the name of the
   * profile of the conversation it points at, read in the same transaction,
   * so a caller that surfaces "started with profile X" names the right one.
   */
  createConversation(
    platformAddress: string,
    platformUserHandle: string,
    opts: { isPrivate: boolean; profileId?: string },
  ): Promise<Result<Session & { profileName: string }, TransportError>>;
  /** Close a session; `stale` when something else closed it first. */
  closeSession(sessionId: string): Promise<CloseSessionOutcome>;
  emit(
    sessionId: string,
    content: InboundContent,
    platformTs: Date,
  ): Promise<Result<void, TransportError>>;
  /** Upload an attachment (image, file) as raw bytes to storage. Returns the storage path. */
  uploadAttachment(data: Buffer, mediaType: string): Promise<string>;

  /** Resume an existing conversation by alias or id. Swaps the address's active session for a new one pointing at the resolved conversation. Rejects non-private conversations and conversations not owned by the caller. */
  resumeConversation(
    platformAddress: string,
    platformUserHandle: string,
    target: { alias: string } | { conversationId: string },
  ): Promise<Result<Session, TransportError>>;
}

export function createSessions(
  deps: TransportContext & {
    defaultProfileId: string;
    inngest: Inngest;
    inboundArrived: typeof InboundArrivedEvent;
    attachments: AttachmentStore;
    idleTimeoutMs: number;
    sessionReceive: "routed" | "all";
  },
): TransportSessions {
  const {
    channelId,
    runInTx,
    transportStore,
    agentStore,
    defaultProfileId,
    inngest,
    inboundArrived,
    attachments,
    idleTimeoutMs,
    sessionReceive,
  } = deps;
  /**
   * The session plus the name of its conversation's profile. Foreign keys
   * from a session row this transaction can see guarantee both rows, so a
   * miss is an invariant violation.
   */
  async function withProfileName(
    tx: Transaction,
    session: Session,
  ): Promise<Session & { profileName: string }> {
    const conv = await agentStore.getConversation(tx, session.conversationId);
    const profile = conv ? await agentStore.getProfile(tx, conv.profileId) : null;
    if (!profile) {
      throw new Error(`session ${session.id}: its conversation's profile row is missing`);
    }
    return { ...session, profileName: profile.name };
  }

  return {
    async resolveSession(platformAddress) {
      return runInTx(async (tx) => {
        const session = await transportStore.resolveSession(tx, channelId, platformAddress);
        if (!session) return null;
        if (idleTimeoutMs <= 0) return session;

        // Lazy rotation: a conversation quiet past the idle window ends here,
        // and the inbound that found it starts a fresh one. The close is
        // conditional; two inbounds reading the same stale session both end
        // up with null, whichever one's close lands.
        const lastActivity = await agentStore.getLastMessageTime(tx, session.conversationId);
        if (!lastActivity || Date.now() - lastActivity.getTime() <= idleTimeoutMs) {
          return session;
        }
        const outcome = await transportStore.closeSession(tx, session.id);
        const fields = { sessionId: session.id, conversationId: session.conversationId };
        match(outcome)
          .with({ kind: "closed" }, () =>
            logger.warn(fields, "session idle-expired via safety net (idle timer may have failed)"),
          )
          .with({ kind: "stale" }, ({ status }) =>
            logger.info({ ...fields, status }, "idle session was already closed"),
          )
          .with({ kind: "not_found" }, () =>
            logger.warn(fields, "idle session vanished between lookup and close"),
          )
          .exhaustive();
        return null;
      });
    },

    async createConversation(platformAddress, platformUserHandle, opts) {
      // Identity resolution: check user_identities for this channel.
      // Wildcard identities (direct channel) accept everyone.
      // Explicit identities (Telegram with allowlist) reject unknown handles.
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) {
          return err({ code: "identity_rejected" as const });
        }
        // Join the address's active session when there is one. On the retry
        // after a concurrent open's `40001`, this read sees that open's row,
        // so the retry inserts nothing of its own.
        const active = await transportStore.resolveSession(tx, channelId, platformAddress);
        if (active) return ok(await withProfileName(tx, active));
        // Fallback chain for the profile used by the new conversation:
        //   explicit `opts.profileId` > per-chat default > global default.
        // The per-chat default is set via `/profile default <name>` and
        // persists across `/new`, so a Telegram chat can be pinned to a
        // specific profile without the user re-stating it every time.
        let profileId = opts.profileId;
        if (!profileId) {
          const chatDefault = await transportStore.getChatDefaultProfile(
            tx,
            channelId,
            platformAddress,
          );
          profileId = chatDefault?.profileId ?? defaultProfileId;
        }
        const conv = await agentStore.createConversation(tx, {
          userId: identity.userId,
          profileId,
          isPrivate: opts.isPrivate,
        });
        // Profile must exist — agentStore.createConversation just succeeded
        // with this id under the same FK, so the only way `getProfile`
        // returns null is a torn tx or schema bug. Surface it as
        // profile_not_found rather than crashing on a null deref.
        const profile = await agentStore.getProfile(tx, profileId);
        if (!profile) return err({ code: "profile_not_found" as const });
        const params = {
          channelId,
          platformAddress,
          conversationId: conv.id,
          status: "active" as const,
          receive: sessionReceive,
        };
        const created = await transportStore.createSession(tx, params);
        return match(created)
          .with({ kind: "new" }, ({ id }) => ok({ id, ...params, profileName: profile.name }))
          .with({ kind: "recovered" }, async () => {
            // The address's active row is one the read above does not
            // return — past its `expires_at`, so unreachable. The fresh
            // conversation supersedes it: the `expire` transition.
            const swapped = await transportStore.swapSession(tx, channelId, platformAddress, {
              conversationId: conv.id,
              status: "active",
              receive: sessionReceive,
            });
            return ok({ id: swapped.id, ...params, profileName: profile.name });
          })
          .exhaustive();
      });
    },

    async closeSession(sessionId) {
      return runInTx((tx) => transportStore.closeSession(tx, sessionId));
    },

    async resumeConversation(platformAddress, platformUserHandle, target) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });

        // Resolve target to a conversationId
        let conversationId: string;
        if ("conversationId" in target) {
          conversationId = target.conversationId;
        } else {
          const row = await agentStore.findConversationByAlias(tx, identity.userId, target.alias);
          if (!row) return err({ code: "conversation_not_found" as const });
          conversationId = row.conversationId;
        }

        // Verify ownership + privacy
        const conv = await agentStore.getConversation(tx, conversationId);
        if (!conv) return err({ code: "conversation_not_found" as const });
        if (conv.userId !== identity.userId) {
          return err({
            code: "access_denied" as const,
            reason: "conversation not owned by caller",
          });
        }
        if (!conv.isPrivate) {
          return err({
            code: "access_denied" as const,
            reason: "cannot resume non-private conversation",
          });
        }

        // Close-old + open-new in one transaction; a failed insert rolls back
        // the close. A concurrent open or swap on the address that commits
        // after this snapshot raises `40001` here, and the retry closes it.
        const newParams = {
          conversationId,
          status: "active" as const,
          receive: sessionReceive,
        };
        const swapped = await transportStore.swapSession(tx, channelId, platformAddress, newParams);
        if (swapped.closedIds.length > 0) {
          logger.info(
            { platformAddress, sessionId: swapped.id, closedSessionIds: swapped.closedIds },
            "resume closed the address's active session",
          );
        }
        return ok({ id: swapped.id, channelId, platformAddress, ...newParams });
      });
    },

    async emit(sessionId, content, platformTs) {
      const inbound = await runInTx(async (tx) => {
        const session = await transportStore.getSession(tx, sessionId);
        if (!session) {
          return null;
        }

        const inbound = await transportStore.persistInbound(tx, {
          channelSessionId: sessionId,
          conversationId: session.conversationId,
          content,
          platformTs,
          source: "user",
        });
        return { conversationId: session.conversationId, inboundId: inbound.id };
      });

      if (!inbound) {
        return err({ code: "session_not_found" as const, sessionId });
      }

      await inngest.send(
        inboundArrived.create({
          conversationId: inbound.conversationId,
          inboundMessageId: inbound.inboundId,
        }),
      );

      return ok(undefined);
    },

    async uploadAttachment(data: Buffer, mediaType: string): Promise<string> {
      return attachments.upload(data, mediaType, "inbound");
    },
  };
}
