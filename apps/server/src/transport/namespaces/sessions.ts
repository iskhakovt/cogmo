import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import type { inboundArrived as InboundArrivedEvent } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { AttachmentStore } from "../attachment-store.js";
import type { InboundContent } from "../content.js";
import type { Session } from "../store/index.js";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";

/** The session lifecycle and inbound emission — the chat path every adapter drives. */
export interface TransportSessions {
  resolveSession(platformAddress: string): Promise<Session | null>;

  /**
   * Create a new conversation and the channel session that points at it.
   *
   * Returns the new session augmented with `profileName` — the name of the
   * profile actually used, resolved inside the same transaction as the
   * conversation insert. Callers that surface "started with profile X" use
   * this directly instead of doing a follow-up `getCurrent` lookup, which
   * would be racy against a concurrent `createConversation` on the same
   * `(channelId, platformAddress)` swapping the active session out from
   * under them.
   */
  createConversation(
    platformAddress: string,
    platformUserHandle: string,
    opts: { isPrivate: boolean; profileId?: string },
  ): Promise<Result<Session & { profileName: string }, TransportError>>;
  closeSession(sessionId: string): Promise<void>;
  emit(
    sessionId: string,
    content: InboundContent,
    platformTs: Date,
  ): Promise<Result<void, TransportError>>;
  /** Upload an attachment (image, file) as raw bytes to storage. Returns the storage path. */
  uploadAttachment(data: Buffer, mediaType: string): Promise<string>;

  /** Resume an existing conversation by alias or id. Closes any active session on this address, then opens a new one pointing at the resolved conversation. Rejects non-private conversations and conversations not owned by the caller. */
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
  return {
    async resolveSession(platformAddress) {
      const session = await runInTx((tx) =>
        transportStore.resolveSession(tx, channelId, platformAddress),
      );
      if (!session) return null;

      // Safety net: expire stale sessions missed by idle timer
      if (idleTimeoutMs > 0) {
        const lastActivity = await runInTx((tx) =>
          agentStore.getLastMessageTime(tx, session.conversationId),
        );
        if (lastActivity && Date.now() - lastActivity.getTime() > idleTimeoutMs) {
          await runInTx((tx) => transportStore.closeSession(tx, session.id));
          logger.warn(
            { sessionId: session.id, conversationId: session.conversationId },
            "session idle-expired via safety net (idle timer may have failed)",
          );
          return null;
        }
      }

      return session;
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
        const { id } = await transportStore.createSession(tx, params);
        return ok({ id, ...params, profileName: profile.name });
      });
    },

    async closeSession(sessionId) {
      await runInTx((tx) => transportStore.closeSession(tx, sessionId));
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

        // Atomic close-old + open-new in one transaction, with the "what's active" lookup
        // happening INSIDE the tx so no concurrent createSession / swapSession on this address
        // can slip between resolve and swap. Failure of the insert rolls back the close.
        const newParams = {
          conversationId,
          status: "active" as const,
          receive: sessionReceive,
        };
        const { id } = await transportStore.swapSession(tx, channelId, platformAddress, newParams);
        return ok({ id, channelId, platformAddress, ...newParams });
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
      return attachments.upload(data, mediaType);
    },
  };
}
