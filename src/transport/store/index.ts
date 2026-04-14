import { and, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { JsonValue } from "type-fest";
import { single } from "../../db/helpers.js";
import type { Database } from "../../db/index.js";
import { channelSessions, channels, inboundMessages, userIdentities } from "./schema.js";

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
  getAllChannels(): Promise<
    ReadonlyArray<{ id: string; type: string; credentials: JsonValue; identityMode: string }>
  >;

  /** Find channel by type. */
  getChannelByType(
    type: string,
  ): Promise<{ id: string; identityMode: string; credentials: JsonValue } | null>;

  /** Create a channel. */
  createChannel(params: {
    type: string;
    credentials: JsonValue;
    identityMode: string;
  }): Promise<{ id: string }>;

  /** Find the active session for a platform address (not closed, not expired). */
  resolveSession(channelId: string, platformAddress: string): Promise<Session | null>;

  /** Create a new session linking a platform address to a conversation. */
  createSession(params: {
    channelId: string;
    platformAddress: string;
    conversationId: string;
    status: string;
    receive: string;
  }): Promise<{ id: string }>;

  /** Close a session (status = 'closed'). */
  closeSession(sessionId: string): Promise<void>;

  /** Persist a raw inbound message. */
  persistInbound(params: {
    channelSessionId: string;
    conversationId: string;
    content: JsonValue;
    platformTs: Date;
  }): Promise<{ id: string }>;

  /** Load unbatched inbound messages after a cursor (null = all). */
  getUnbatchedInbound(
    conversationId: string,
    afterId: string | null,
  ): Promise<ReadonlyArray<{ id: string; content: JsonValue }>>;

  /** Get a session by ID. */
  getSession(sessionId: string): Promise<Session | null>;

  /** Find all active sessions for a conversation (for lifecycle management). */
  getActiveSessionsForConversation(conversationId: string): Promise<ReadonlyArray<Session>>;

  /** Get distinct channel types for a conversation's active sessions. */
  getActiveChannelTypes(conversationId: string): Promise<ReadonlyArray<string>>;

  /** Find sessions that contributed inbound messages in the given range (source routing). */
  getSourceSessions(params: {
    conversationId: string;
    prevCursor: string | null;
    maxInboundId: string;
  }): Promise<ReadonlyArray<Session>>;

  /** Find active sessions with receive='all' for a conversation. */
  getReceiveAllSessions(conversationId: string): Promise<ReadonlyArray<Session>>;

  /** Resolve user by platform handle on a channel. Stub — identity resolution is a future feature. */
  resolveUser(channelId: string, platformHandle: string): Promise<{ userId: string } | null>;

  /** Create a wildcard identity for a channel. */
  createWildcardIdentity(params: { userId: string; channelId: string }): Promise<{ id: string }>;

  /** Create an explicit (non-wildcard) identity for a user on a channel. */
  createIdentity(params: {
    userId: string;
    channelId: string;
    platformHandle: string;
  }): Promise<{ id: string }>;

  /** Update channel credentials (e.g., token rotation). */
  updateChannelCredentials(channelId: string, credentials: JsonValue): Promise<void>;

  /** Remove a channel and its sessions/identities. */
  removeChannel(channelId: string): Promise<void>;
}

export class DrizzleTransportStore implements TransportStore {
  #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }

  async getAllChannels(): Promise<
    ReadonlyArray<{ id: string; type: string; credentials: JsonValue; identityMode: string }>
  > {
    return this.#db.transaction(async (tx) => {
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
    });
  }

  async getChannelByType(
    type: string,
  ): Promise<{ id: string; identityMode: string; credentials: JsonValue } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: channels.id,
          identityMode: channels.identityMode,
          credentials: channels.credentials,
        })
        .from(channels)
        .where(eq(channels.type, type))
        .limit(1);
      return (rows[0] as { id: string; identityMode: string; credentials: JsonValue }) ?? null;
    });
  }

  async createChannel(params: {
    type: string;
    credentials: JsonValue;
    identityMode: string;
  }): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
      return single(await tx.insert(channels).values(params).returning({ id: channels.id }));
    });
  }

  async resolveSession(channelId: string, platformAddress: string): Promise<Session | null> {
    return this.#db.transaction(async (tx) => {
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
      return rows[0] ?? null;
    });
  }

  async createSession(params: {
    channelId: string;
    platformAddress: string;
    conversationId: string;
    status: string;
    receive: string;
  }): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
      return single(
        await tx.insert(channelSessions).values(params).returning({ id: channelSessions.id }),
      );
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .update(channelSessions)
        .set({ status: "closed" })
        .where(eq(channelSessions.id, sessionId));
    });
  }

  async persistInbound(params: {
    channelSessionId: string;
    conversationId: string;
    content: JsonValue;
    platformTs: Date;
  }): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
      return single(
        await tx.insert(inboundMessages).values(params).returning({ id: inboundMessages.id }),
      );
    });
  }

  async getUnbatchedInbound(
    conversationId: string,
    afterId: string | null,
  ): Promise<ReadonlyArray<{ id: string; content: JsonValue }>> {
    return this.#db.transaction(async (tx) => {
      const conditions = [eq(inboundMessages.conversationId, conversationId)];
      if (afterId) {
        conditions.push(gt(inboundMessages.id, afterId));
      }
      return tx
        .select({ id: inboundMessages.id, content: inboundMessages.content })
        .from(inboundMessages)
        .where(and(...conditions))
        .orderBy(inboundMessages.id) as Promise<ReadonlyArray<{ id: string; content: JsonValue }>>;
    });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.#db.transaction(async (tx) => {
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
      return rows[0] ?? null;
    });
  }

  async getActiveSessionsForConversation(conversationId: string): Promise<ReadonlyArray<Session>> {
    return this.#db.transaction(async (tx) => {
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
    });
  }

  async getActiveChannelTypes(conversationId: string): Promise<ReadonlyArray<string>> {
    return this.#db.transaction(async (tx) => {
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
    });
  }

  async getSourceSessions(params: {
    conversationId: string;
    prevCursor: string | null;
    maxInboundId: string;
  }): Promise<ReadonlyArray<Session>> {
    return this.#db.transaction(async (tx) => {
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
    });
  }

  async getReceiveAllSessions(conversationId: string): Promise<ReadonlyArray<Session>> {
    return this.#db.transaction(async (tx) => {
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
    });
  }

  async resolveUser(channelId: string, platformHandle: string): Promise<{ userId: string } | null> {
    return this.#db.transaction(async (tx) => {
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
      return exact[0] ?? null;
    });
  }

  async createWildcardIdentity(params: {
    userId: string;
    channelId: string;
  }): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
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
    });
  }

  async createIdentity(params: {
    userId: string;
    channelId: string;
    platformHandle: string;
  }): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
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
    });
  }

  async updateChannelCredentials(channelId: string, credentials: JsonValue): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(channels).set({ credentials }).where(eq(channels.id, channelId));
    });
  }

  async removeChannel(channelId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
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
    });
  }
}
