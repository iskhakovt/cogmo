import { randomUUID } from "node:crypto";
import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import type { JsonValue } from "type-fest";
import type { Service } from "../agent/service.js";
import type { AgentStore } from "../agent/store/index.js";
import type { inboundArrived as InboundArrivedEvent } from "../inngest/events.js";
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
  /** Upload an attachment (image, file) to storage. Returns the storage path. */
  uploadAttachment(data: string, mediaType: string): Promise<string>;
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
  files: Service["files"];
}): Transport {
  const {
    channelId,
    defaultUserId,
    defaultProfileId,
    transportStore,
    agentStore,
    inngest,
    inboundArrived,
    files,
  } = deps;

  return {
    async resolveSession(platformAddress) {
      return transportStore.resolveSession(channelId, platformAddress);
    },

    async createConversation(platformAddress, _platformUserHandle, opts) {
      // TODO: identity resolution — for now, use defaultUserId
      const conv = await agentStore.createConversation({
        userId: defaultUserId,
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

    async uploadAttachment(data: string, mediaType: string): Promise<string> {
      const ext = mediaType.split("/")[1] ?? "bin";
      const path = `inbound/${randomUUID()}.${ext}`;
      await files.write(path, data);
      return path;
    },
  };
}
