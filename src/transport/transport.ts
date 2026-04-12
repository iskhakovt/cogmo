import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import type { JsonValue } from "type-fest";
import type { AgentStore } from "../agent/store/index.js";
import type { inboundArrived as InboundArrivedEvent } from "../inngest/events.js";
import { logger } from "../logger.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { Session, TransportStore } from "./store/index.js";

export type TransportError =
  | { code: "session_not_found"; sessionId: string }
  | { code: "identity_rejected" }
  | { code: "conversation_not_found" };

/**
 * Transport — the adapter-facing contract for session management and inbound emission.
 *
 * Scoped to a channel (channelId baked in). Adapters call it without knowing
 * about channelId, userId resolution, or event emission mechanics.
 *
 * Returns Result<T, TransportError> — adapters handle errors gracefully.
 */
export interface Transport {
  resolveSession(platformAddress: string): Promise<Session | null>;
  createConversation(
    platformAddress: string,
    platformUserHandle: string,
    opts: { isPrivate: boolean },
  ): Promise<Result<Session, TransportError>>;
  closeSession(sessionId: string): Promise<void>;
  emit(
    sessionId: string,
    content: JsonValue,
    platformTs: Date,
  ): Promise<Result<void, TransportError>>;
  /** Upload an attachment (image, file) as raw bytes to storage. Returns the storage path. */
  uploadAttachment(data: Buffer, mediaType: string): Promise<string>;
}

/**
 * Create a Transport scoped to a channel.
 */
export function createTransport(deps: {
  channelId: string;
  defaultUserId: string;
  defaultProfileId: string;
  transportStore: TransportStore;
  agentStore: AgentStore;
  inngest: Inngest;
  inboundArrived: typeof InboundArrivedEvent;
  attachments: AttachmentStore;
  idleTimeoutMs: number;
}): Transport {
  const {
    channelId,
    defaultUserId,
    defaultProfileId,
    transportStore,
    agentStore,
    inngest,
    inboundArrived,
    attachments,
    idleTimeoutMs,
  } = deps;

  return {
    async resolveSession(platformAddress) {
      const session = await transportStore.resolveSession(channelId, platformAddress);
      if (!session) return null;

      // Safety net: expire stale sessions missed by idle timer
      if (idleTimeoutMs > 0) {
        const lastActivity = await agentStore.getLastMessageTime(session.conversationId);
        if (lastActivity && Date.now() - lastActivity.getTime() > idleTimeoutMs) {
          await transportStore.closeSession(session.id);
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
      const identity = await transportStore.resolveUser(channelId, platformUserHandle);
      if (!identity) {
        return err({ code: "identity_rejected" as const });
      }
      const conv = await agentStore.createConversation({
        userId: identity.userId,
        profileId: defaultProfileId,
        isPrivate: opts.isPrivate,
      });
      const params = {
        channelId,
        platformAddress,
        conversationId: conv.id,
        status: "active" as const,
        receive: "routed" as const,
      };
      const { id } = await transportStore.createSession(params);
      return ok({ id, ...params });
    },

    async closeSession(sessionId) {
      await transportStore.closeSession(sessionId);
    },

    async emit(sessionId, content, platformTs) {
      const session = await transportStore.getSession(sessionId);
      if (!session) {
        return err({ code: "session_not_found" as const, sessionId });
      }

      const inbound = await transportStore.persistInbound({
        channelSessionId: sessionId,
        conversationId: session.conversationId,
        content,
        platformTs,
      });

      await inngest.send(
        inboundArrived.create({
          conversationId: session.conversationId,
          inboundMessageId: inbound.id,
        }),
      );

      return ok(undefined);
    },

    async uploadAttachment(data: Buffer, mediaType: string): Promise<string> {
      return attachments.upload(data, mediaType);
    },
  };
}
