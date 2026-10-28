import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { InboundContent } from "../../agent/conversation/inbound-content.js";
import type { inboundArrived as InboundArrivedEvent } from "../../inngest/events.js";
import type { AttachmentStore } from "../attachment-store.js";
import { createSession, type OpenedSession } from "../sessions/create-session.js";
import { resolveSession } from "../sessions/resolve-session.js";
import { resumeSession } from "../sessions/resume-session.js";
import { supersedeSession } from "../sessions/supersede-session.js";
import type { CloseActiveSessionOutcome, CloseSessionOutcome, Session } from "../store/index.js";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";

/**
 * How `createConversation` treats a session already active on the address:
 * join it (the first-message path, which has no profile to apply), or
 * supersede it with the fresh conversation, under an explicit profile if any.
 */
export type CreateConversationOpts =
  | { isPrivate: boolean; supersede?: false }
  | { isPrivate: boolean; supersede: true; profileId?: string };

/** The session lifecycle and inbound emission — the chat path every adapter drives. */
export interface TransportSessions {
  /**
   * The active session on `platformAddress`, or null. When the session's
   * conversation has been quiet past the idle window, closes it and returns
   * null — the lookup, the idle check and the close share one transaction.
   */
  resolveSession(platformAddress: string): Promise<Session | null>;

  /**
   * Open a fresh conversation on `platformAddress` and return its session,
   * with the name of the profile it runs under.
   *
   * Without `supersede`, an active session already on the address is
   * returned instead — two first inbounds racing on an address converge on
   * one conversation. With `supersede`, whatever is active on the address is
   * closed and the fresh conversation takes it, in one transaction (`/new`).
   */
  createConversation(
    platformAddress: string,
    platformUserHandle: string,
    opts: CreateConversationOpts,
  ): Promise<Result<OpenedSession, TransportError>>;
  /** Close a session by id; `stale` when something else closed it first. */
  closeSession(sessionId: string): Promise<CloseSessionOutcome>;
  /** Close the address's active session, if any, in one statement. */
  closeActiveSession(platformAddress: string): Promise<CloseActiveSessionOutcome>;
  /**
   * Persist an inbound on an active session and emit `inbound/arrived`.
   * The session row is read under a share lock, so a close that commits
   * between the caller's `resolveSession` and this write is seen (or raises
   * `40001` and is seen on the retry): a closed session is refused as
   * `session_closed`, a missing one as `session_not_found`, and nothing is
   * written. An address-keyed caller re-resolves the address and emits to
   * its current session; a conversation-scoped one reports the refusal.
   */
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
  const stores = { transportStore, agentStore };
  return {
    async resolveSession(platformAddress) {
      return runInTx((tx) =>
        resolveSession(stores, tx, { channelId, platformAddress, idleTimeoutMs }),
      );
    },

    async createConversation(platformAddress, platformUserHandle, opts) {
      // Identity resolution: check user_identities for this channel.
      // Wildcard identities (direct channel) accept everyone.
      // Explicit identities (Telegram with allowlist) reject unknown handles.
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const args = {
          channelId,
          platformAddress,
          userId: identity.userId,
          isPrivate: opts.isPrivate,
          defaultProfileId,
          receive: sessionReceive,
        };
        if (opts.supersede === true) {
          return ok(await supersedeSession(stores, tx, { ...args, profileId: opts.profileId }));
        }
        return ok(await createSession(stores, tx, args));
      });
    },

    async closeSession(sessionId) {
      return runInTx((tx) => transportStore.closeSession(tx, sessionId));
    },

    async closeActiveSession(platformAddress) {
      return runInTx((tx) => transportStore.closeActiveSession(tx, channelId, platformAddress));
    },

    async resumeConversation(platformAddress, platformUserHandle, target) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });

        let conversationId: string;
        if ("conversationId" in target) {
          conversationId = target.conversationId;
        } else {
          const row = await agentStore.findConversationByAlias(tx, identity.userId, target.alias);
          if (!row) return err({ code: "conversation_not_found" as const });
          conversationId = row.conversationId;
        }

        return resumeSession(stores, tx, {
          channelId,
          platformAddress,
          userId: identity.userId,
          conversationId,
          receive: sessionReceive,
        });
      });
    },

    async emit(sessionId, content, platformTs) {
      const outcome = await runInTx(async (tx) => {
        const session = await transportStore.lockSession(tx, sessionId);
        if (!session) return { kind: "not_found" } as const;
        return match(session.status)
          .with("closed", () => ({ kind: "closed" }) as const)
          .with("active", async () => {
            const inbound = await transportStore.persistInbound(tx, {
              channelSessionId: sessionId,
              conversationId: session.conversationId,
              content,
              platformTs,
              source: "user",
            });
            return {
              kind: "persisted",
              conversationId: session.conversationId,
              inboundId: inbound.id,
            } as const;
          })
          .exhaustive();
      });

      return match(outcome)
        .with({ kind: "not_found" }, () => err({ code: "session_not_found" as const, sessionId }))
        .with({ kind: "closed" }, () => err({ code: "session_closed" as const, sessionId }))
        .with({ kind: "persisted" }, async ({ conversationId, inboundId }) => {
          await inngest.send(
            inboundArrived.create({ conversationId, inboundMessageId: inboundId }),
          );
          return ok(undefined);
        })
        .exhaustive();
    },

    async uploadAttachment(data: Buffer, mediaType: string): Promise<string> {
      return attachments.upload(data, mediaType, "inbound");
    },
  };
}
