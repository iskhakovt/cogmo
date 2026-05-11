import { and, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { JsonValue } from "type-fest";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import type { InboundContent } from "../content.js";
import {
  channelSessions,
  channels,
  chatDefaultProfiles,
  inboundMessages,
  userIdentities,
} from "./schema.js";

export interface Session {
  id: string;
  channelId: string;
  platformAddress: string;
  conversationId: string;
  status: string;
  receive: string;
}

export interface TransportStore {
  /** List all channels. */
  getAllChannels(
    tx: Transaction,
  ): Promise<
    ReadonlyArray<{ id: string; type: string; credentials: JsonValue; identityMode: string }>
  >;

  /** Find channel by type. */
  getChannelByType(
    tx: Transaction,
    type: string,
  ): Promise<{ id: string; identityMode: string; credentials: JsonValue } | undefined>;

  /** Create a channel. */
  createChannel(
    tx: Transaction,
    params: {
      type: string;
      credentials: JsonValue;
      identityMode: string;
    },
  ): Promise<{ id: string }>;

  /** Find the active session for a platform address (not closed, not expired). */
  resolveSession(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
  ): Promise<Session | undefined>;

  /** Create a new session linking a platform address to a conversation. */
  createSession(
    tx: Transaction,
    params: {
      channelId: string;
      platformAddress: string;
      conversationId: string;
      status: string;
      receive: string;
    },
  ): Promise<{ id: string }>;

  /** Close a session (status = 'closed'). */
  closeSession(tx: Transaction, sessionId: string): Promise<void>;

  /**
   * Atomically close any active session on `(channelId, platformAddress)` and open a new one,
   * in a single transaction. Used by `resumeConversation` — both the close and the insert (and
   * the lookup that decides what to close) happen under the same snapshot, so no concurrent
   * `createSession`/`swapSession` on the same address can slip between resolve and swap.
   */
  swapSession(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
    newParams: {
      conversationId: string;
      status: string;
      receive: string;
    },
  ): Promise<{ id: string }>;

  /** Persist a raw inbound message. */
  persistInbound(
    tx: Transaction,
    params: {
      channelSessionId: string;
      conversationId: string;
      content: InboundContent;
      platformTs: Date;
    },
  ): Promise<{ id: string }>;

  /** Load unbatched inbound messages after a cursor (null = all). */
  getUnbatchedInbound(
    tx: Transaction,
    conversationId: string,
    afterId: string | null,
  ): Promise<ReadonlyArray<{ id: string; content: InboundContent }>>;

  /** Get a session by ID. */
  getSession(tx: Transaction, sessionId: string): Promise<Session | undefined>;

  /** Find all active sessions for a conversation (for lifecycle management). */
  getActiveSessionsForConversation(
    tx: Transaction,
    conversationId: string,
  ): Promise<ReadonlyArray<Session>>;

  /** Get distinct channel types for a conversation's active sessions. */
  getActiveChannelTypes(tx: Transaction, conversationId: string): Promise<ReadonlyArray<string>>;

  /**
   * Smallest `voice_max_reply_chars` across active channels for the
   * conversation, or null when no active channels exist. The orchestrator
   * uses this as a TTS cap — replies above the cap are skipped (text
   * already streamed). See design/voice.md → "Edge cases & policies".
   */
  getVoiceMaxReplyChars(tx: Transaction, conversationId: string): Promise<number | null>;

  /** Find sessions that contributed inbound messages in the given range (source routing). */
  getSourceSessions(
    tx: Transaction,
    params: {
      conversationId: string;
      prevCursor: string | null;
      maxInboundId: string;
    },
  ): Promise<ReadonlyArray<Session>>;

  /** Find active sessions with receive='all' for a conversation. */
  getReceiveAllSessions(tx: Transaction, conversationId: string): Promise<ReadonlyArray<Session>>;

  /** Resolve user by platform handle on a channel. Stub — identity resolution is a future feature. */
  resolveUser(
    tx: Transaction,
    channelId: string,
    platformHandle: string,
  ): Promise<{ userId: string } | undefined>;

  /** Create a wildcard identity for a channel. */
  createWildcardIdentity(
    tx: Transaction,
    params: { userId: string; channelId: string },
  ): Promise<{ id: string }>;

  /** Create an explicit (non-wildcard) identity for a user on a channel. */
  createIdentity(
    tx: Transaction,
    params: {
      userId: string;
      channelId: string;
      platformHandle: string;
    },
  ): Promise<{ id: string }>;

  /**
   * Look up the per-chat default profile for `(channelId, platformAddress)`.
   * Returns the profile id when a row exists, else `undefined`. The Transport
   * uses this to seed `createConversation` when the caller didn't pass an
   * explicit profile.
   */
  getChatDefaultProfile(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
  ): Promise<{ profileId: string } | undefined>;

  /**
   * Upsert the per-chat default profile. Same `(channelId, platformAddress)`
   * key as `getChatDefaultProfile` — second call with a different profile
   * overwrites the first.
   */
  setChatDefaultProfile(
    tx: Transaction,
    params: { channelId: string; platformAddress: string; profileId: string },
  ): Promise<void>;

  /**
   * Delete the per-chat default profile binding. Idempotent — a no-op when
   * no row exists.
   */
  clearChatDefaultProfile(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
  ): Promise<void>;

  /** Update channel credentials (e.g., token rotation). */
  updateChannelCredentials(
    tx: Transaction,
    channelId: string,
    credentials: JsonValue,
  ): Promise<void>;

  /** Remove a channel and its sessions/identities. */
  removeChannel(tx: Transaction, channelId: string): Promise<void>;
}

export class DrizzleTransportStore implements TransportStore {
  async getAllChannels(
    tx: Transaction,
  ): Promise<
    ReadonlyArray<{ id: string; type: string; credentials: JsonValue; identityMode: string }>
  > {
    return tx
      .select({
        id: channels.id,
        type: channels.type,
        credentials: channels.credentials,
        identityMode: channels.identityMode,
      })
      .from(channels) as Promise<
      ReadonlyArray<{ id: string; type: string; credentials: JsonValue; identityMode: string }>
    >;
  }

  async getChannelByType(
    tx: Transaction,
    type: string,
  ): Promise<{ id: string; identityMode: string; credentials: JsonValue } | undefined> {
    const rows = await tx
      .select({
        id: channels.id,
        identityMode: channels.identityMode,
        credentials: channels.credentials,
      })
      .from(channels)
      .where(eq(channels.type, type))
      .limit(1);
    // `credentials` is opaque ciphertext (raw `jsonb()`, no Zod schema),
    // so Drizzle infers it as `unknown`; cast restores the JsonValue
    // contract the adapter wire format depends on.
    return rows[0] as { id: string; identityMode: string; credentials: JsonValue } | undefined;
  }

  async createChannel(
    tx: Transaction,
    params: {
      type: string;
      credentials: JsonValue;
      identityMode: string;
    },
  ): Promise<{ id: string }> {
    return single(await tx.insert(channels).values(params).returning({ id: channels.id }));
  }

  async resolveSession(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
  ): Promise<Session | undefined> {
    const rows = await tx
      .select({
        id: channelSessions.id,
        channelId: channelSessions.channelId,
        platformAddress: channelSessions.platformAddress,
        conversationId: channelSessions.conversationId,
        status: channelSessions.status,
        receive: channelSessions.receive,
      })
      .from(channelSessions)
      .where(
        and(
          eq(channelSessions.channelId, channelId),
          eq(channelSessions.platformAddress, platformAddress),
          eq(channelSessions.status, "active"),
          or(isNull(channelSessions.expiresAt), gt(channelSessions.expiresAt, sql`now()`)),
        ),
      )
      .orderBy(desc(channelSessions.id))
      .limit(1);
    return rows[0];
  }

  async createSession(
    tx: Transaction,
    params: {
      channelId: string;
      platformAddress: string;
      conversationId: string;
      status: string;
      receive: string;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx.insert(channelSessions).values(params).returning({ id: channelSessions.id }),
    );
  }

  async closeSession(tx: Transaction, sessionId: string): Promise<void> {
    await tx
      .update(channelSessions)
      .set({ status: "closed" })
      .where(eq(channelSessions.id, sessionId));
  }

  async swapSession(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
    newParams: {
      conversationId: string;
      status: string;
      receive: string;
    },
  ): Promise<{ id: string }> {
    // Close ALL active sessions on this (channelId, platformAddress) inside the tx.
    // There should be at most one under normal usage, but closing set-wise is race-safe:
    // a concurrent createSession landing between our close and insert would be impossible
    // because both statements share the same transactional snapshot.
    await tx
      .update(channelSessions)
      .set({ status: "closed" })
      .where(
        and(
          eq(channelSessions.channelId, channelId),
          eq(channelSessions.platformAddress, platformAddress),
          eq(channelSessions.status, "active"),
        ),
      );
    return single(
      await tx
        .insert(channelSessions)
        .values({ channelId, platformAddress, ...newParams })
        .returning({ id: channelSessions.id }),
    );
  }

  async persistInbound(
    tx: Transaction,
    params: {
      channelSessionId: string;
      conversationId: string;
      content: InboundContent;
      platformTs: Date;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx.insert(inboundMessages).values(params).returning({ id: inboundMessages.id }),
    );
  }

  async getUnbatchedInbound(
    tx: Transaction,
    conversationId: string,
    afterId: string | null,
  ): Promise<ReadonlyArray<{ id: string; content: InboundContent }>> {
    const conditions = [eq(inboundMessages.conversationId, conversationId)];
    if (afterId) {
      conditions.push(gt(inboundMessages.id, afterId));
    }
    return tx
      .select({ id: inboundMessages.id, content: inboundMessages.content })
      .from(inboundMessages)
      .where(and(...conditions))
      .orderBy(inboundMessages.id);
  }

  async getSession(tx: Transaction, sessionId: string): Promise<Session | undefined> {
    const rows = await tx
      .select({
        id: channelSessions.id,
        channelId: channelSessions.channelId,
        platformAddress: channelSessions.platformAddress,
        conversationId: channelSessions.conversationId,
        status: channelSessions.status,
        receive: channelSessions.receive,
      })
      .from(channelSessions)
      .where(eq(channelSessions.id, sessionId))
      .limit(1);
    return rows[0];
  }

  async getActiveSessionsForConversation(
    tx: Transaction,
    conversationId: string,
  ): Promise<ReadonlyArray<Session>> {
    return tx
      .select({
        id: channelSessions.id,
        channelId: channelSessions.channelId,
        platformAddress: channelSessions.platformAddress,
        conversationId: channelSessions.conversationId,
        status: channelSessions.status,
        receive: channelSessions.receive,
      })
      .from(channelSessions)
      .where(
        and(
          eq(channelSessions.conversationId, conversationId),
          eq(channelSessions.status, "active"),
          or(isNull(channelSessions.expiresAt), gt(channelSessions.expiresAt, sql`now()`)),
        ),
      );
  }

  async getActiveChannelTypes(
    tx: Transaction,
    conversationId: string,
  ): Promise<ReadonlyArray<string>> {
    const rows = await tx
      .selectDistinct({ type: channels.type })
      .from(channelSessions)
      .innerJoin(channels, eq(channelSessions.channelId, channels.id))
      .where(
        and(
          eq(channelSessions.conversationId, conversationId),
          eq(channelSessions.status, "active"),
          or(isNull(channelSessions.expiresAt), gt(channelSessions.expiresAt, sql`now()`)),
        ),
      );
    return rows.map((r) => r.type);
  }

  async getVoiceMaxReplyChars(tx: Transaction, conversationId: string): Promise<number | null> {
    const rows = await tx
      .select({ cap: channels.voiceMaxReplyChars })
      .from(channelSessions)
      .innerJoin(channels, eq(channelSessions.channelId, channels.id))
      .where(
        and(
          eq(channelSessions.conversationId, conversationId),
          eq(channelSessions.status, "active"),
          or(isNull(channelSessions.expiresAt), gt(channelSessions.expiresAt, sql`now()`)),
        ),
      );
    const first = rows[0];
    if (!first) return null;
    // Take the smallest cap across active channels — the most-restrictive
    // wins so a session on a strict-budget channel doesn't get a long
    // voice clip just because another session permits it.
    return rows.reduce((min, r) => (r.cap < min ? r.cap : min), first.cap);
  }

  async getSourceSessions(
    tx: Transaction,
    params: {
      conversationId: string;
      prevCursor: string | null;
      maxInboundId: string;
    },
  ): Promise<ReadonlyArray<Session>> {
    const conditions = [
      eq(inboundMessages.conversationId, params.conversationId),
      lte(inboundMessages.id, params.maxInboundId),
      eq(channelSessions.status, "active"),
      ne(channelSessions.receive, "none"),
      or(isNull(channelSessions.expiresAt), gt(channelSessions.expiresAt, sql`now()`)),
    ];
    if (params.prevCursor) {
      conditions.push(gt(inboundMessages.id, params.prevCursor));
    }
    return tx
      .selectDistinctOn([channelSessions.id], {
        id: channelSessions.id,
        channelId: channelSessions.channelId,
        platformAddress: channelSessions.platformAddress,
        conversationId: channelSessions.conversationId,
        status: channelSessions.status,
        receive: channelSessions.receive,
      })
      .from(inboundMessages)
      .innerJoin(channelSessions, eq(inboundMessages.channelSessionId, channelSessions.id))
      .where(and(...conditions));
  }

  async getReceiveAllSessions(
    tx: Transaction,
    conversationId: string,
  ): Promise<ReadonlyArray<Session>> {
    return tx
      .select({
        id: channelSessions.id,
        channelId: channelSessions.channelId,
        platformAddress: channelSessions.platformAddress,
        conversationId: channelSessions.conversationId,
        status: channelSessions.status,
        receive: channelSessions.receive,
      })
      .from(channelSessions)
      .where(
        and(
          eq(channelSessions.conversationId, conversationId),
          eq(channelSessions.status, "active"),
          eq(channelSessions.receive, "all"),
          or(isNull(channelSessions.expiresAt), gt(channelSessions.expiresAt, sql`now()`)),
        ),
      );
  }

  async resolveUser(
    tx: Transaction,
    channelId: string,
    platformHandle: string,
  ): Promise<{ userId: string } | undefined> {
    // Check wildcard first
    const wildcard = await tx
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(and(eq(userIdentities.channelId, channelId), eq(userIdentities.isWildcard, true)))
      .limit(1);
    if (wildcard[0]) return wildcard[0];

    // Then exact match
    const exact = await tx
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.channelId, channelId),
          eq(userIdentities.platformHandle, platformHandle),
        ),
      )
      .limit(1);
    return exact[0];
  }

  async createWildcardIdentity(
    tx: Transaction,
    params: {
      userId: string;
      channelId: string;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(userIdentities)
        .values({
          ...params,
          isWildcard: true,
          autoCreated: false,
        })
        .returning({ id: userIdentities.id }),
    );
  }

  async createIdentity(
    tx: Transaction,
    params: {
      userId: string;
      channelId: string;
      platformHandle: string;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(userIdentities)
        .values({
          userId: params.userId,
          channelId: params.channelId,
          platformHandle: params.platformHandle,
          isWildcard: false,
          autoCreated: false,
        })
        .returning({ id: userIdentities.id }),
    );
  }

  async getChatDefaultProfile(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
  ): Promise<{ profileId: string } | undefined> {
    const rows = await tx
      .select({ profileId: chatDefaultProfiles.profileId })
      .from(chatDefaultProfiles)
      .where(
        and(
          eq(chatDefaultProfiles.channelId, channelId),
          eq(chatDefaultProfiles.platformAddress, platformAddress),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async setChatDefaultProfile(
    tx: Transaction,
    params: { channelId: string; platformAddress: string; profileId: string },
  ): Promise<void> {
    await tx
      .insert(chatDefaultProfiles)
      .values(params)
      .onConflictDoUpdate({
        target: [chatDefaultProfiles.channelId, chatDefaultProfiles.platformAddress],
        set: { profileId: params.profileId },
      });
  }

  async clearChatDefaultProfile(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
  ): Promise<void> {
    await tx
      .delete(chatDefaultProfiles)
      .where(
        and(
          eq(chatDefaultProfiles.channelId, channelId),
          eq(chatDefaultProfiles.platformAddress, platformAddress),
        ),
      );
  }

  async updateChannelCredentials(
    tx: Transaction,
    channelId: string,
    credentials: JsonValue,
  ): Promise<void> {
    await tx.update(channels).set({ credentials }).where(eq(channels.id, channelId));
  }

  async removeChannel(tx: Transaction, channelId: string): Promise<void> {
    // Delete in FK order: inbound_messages → channel_sessions → identities → channel
    const sessionIds = await tx
      .select({ id: channelSessions.id })
      .from(channelSessions)
      .where(eq(channelSessions.channelId, channelId));
    const ids = sessionIds.map((s) => s.id);
    if (ids.length > 0) {
      await tx.delete(inboundMessages).where(inArray(inboundMessages.channelSessionId, ids));
    }
    await tx.delete(channelSessions).where(eq(channelSessions.channelId, channelId));
    await tx.delete(userIdentities).where(eq(userIdentities.channelId, channelId));
    await tx.delete(channels).where(eq(channels.id, channelId));
  }
}
