import { and, desc, eq, gt, inArray, isNull, lt, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JsonValue } from "type-fest";
// Cross-module read: scheduled-task fire routing needs conversations.{user_id, profile_id}
// joined to channel_sessions. Per CLAUDE.md → Store Pattern, store impls may import
// any schema; the access boundary is the TransportStore interface.
import { aliases, conversations, messages } from "../../agent/store/schema.js";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import type { InboundContent } from "../content.js";
import {
  type BufferedInboundEntry,
  boundaryPending,
  type ChannelSessionReceive,
  type ChannelSessionStatus,
  channelSessions,
  channels,
  chatDefaultProfiles,
  type InboundMessageSource,
  inboundMessages,
  userIdentities,
} from "./schema.js";

export interface Session {
  id: string;
  channelId: string;
  platformAddress: string;
  conversationId: string;
  status: ChannelSessionStatus;
  receive: ChannelSessionReceive;
}

/**
 * Discriminated input for `persistInbound`. `user` rows carry their
 * originating session FK; `scheduled` rows carry the idempotency key.
 */
export type PersistInboundParams =
  | {
      source: "user";
      channelSessionId: string;
      conversationId: string;
      content: InboundContent;
      platformTs: Date;
    }
  | {
      source: "scheduled";
      scheduledFireKey: string;
      conversationId: string;
      content: InboundContent;
      platformTs: Date;
    };

/** `(channelId, platformAddress, receive)` tuple from `findReachableChannelsForUserProfile`. */
export interface ReachableChannel {
  channelId: string;
  platformAddress: string;
  receive: ChannelSessionReceive;
}

export type { BufferedInboundEntry };

/**
 * Snapshot of the most-recently-closed prior conversation on a chat — used by
 * the adapter to decide whether to fire a boundary-resume prompt. Returned by
 * `peekPriorClosedConversation` when (a) a closed session exists on this
 * address and (b) its conversation accumulated enough user turns to be worth
 * asking about. `firstUserSnippet` is a short text excerpt of the first user
 * turn (≤ the cap the caller passed) used for the Resume button label.
 */
export interface PriorClosedConversation {
  conversationId: string;
  userTurnCount: number;
  lastMessageAt: Date | null;
  alias: string | null;
  firstUserSnippet: string | null;
}

/** A held boundary-prompt row — see schema.ts → boundary_pending. */
export interface BoundaryPendingRow {
  id: string;
  channelId: string;
  platformAddress: string;
  platformUserHandle: string;
  priorConversationId: string;
  promptMessageId: string;
  bufferedInbounds: ReadonlyArray<BufferedInboundEntry>;
  expiresAt: Date;
  createdAt: Date;
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
      status: ChannelSessionStatus;
      receive: ChannelSessionReceive;
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
      status: ChannelSessionStatus;
      receive: ChannelSessionReceive;
    },
  ): Promise<{ id: string }>;

  /**
   * Persist a raw inbound message. The `source` discriminator selects which
   * additional fields must be supplied:
   *   - `'user'` → `channelSessionId` (originating session).
   *   - `'scheduled'` → `scheduledFireKey` (idempotency key
   *     `${taskId}:${scheduledFor}`; UNIQUE WHERE NOT NULL).
   * The DB check constraint enforces this; the type narrows it at the
   * call site.
   */
  persistInbound(tx: Transaction, params: PersistInboundParams): Promise<{ id: string }>;

  /**
   * Look up a scheduled-source inbound by its idempotency key. Returns
   * `undefined` when the fire hasn't been dispatched yet. Used by the
   * fire-handler to short-circuit a retry that lands after the original
   * tx committed but before Inngest got the step ack.
   */
  findInboundByScheduledFireKey(
    tx: Transaction,
    scheduledFireKey: string,
  ): Promise<{ id: string; conversationId: string } | undefined>;

  /** Load unbatched inbound messages after a cursor (null = all). */
  getUnbatchedInbound(
    tx: Transaction,
    conversationId: string,
    afterId: string | null,
  ): Promise<ReadonlyArray<{ id: string; content: InboundContent; source: InboundMessageSource }>>;

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

  /**
   * Every reachable channel for `(userId, profileId)`, distinct on
   * `(channelId, platformAddress)` with the newest row's `receive` mode.
   * Closed sessions are included — a `/end`-ed Telegram chat is still
   * reachable, the rotation just opens a fresh session against the same
   * `(channelId, platformAddress)`. Sessions with `expires_at` in the past
   * are excluded (Web UI client gone).
   */
  findReachableChannelsForUserProfile(
    tx: Transaction,
    userId: string,
    profileId: string,
  ): Promise<ReadonlyArray<ReachableChannel>>;

  /**
   * Look up the most-recently-closed conversation for `(channelId, address)`
   * and return its snapshot only if it accumulated `>= minUserTurns` user
   * messages. Returns `undefined` when there's no prior session, the prior
   * session is still active (resolveSession would have returned it), or the
   * prior wasn't substantial enough to be worth resuming. `snippetMaxChars`
   * caps the rendered first-user-message excerpt length.
   */
  peekPriorClosedConversation(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
    minUserTurns: number,
    snippetMaxChars: number,
  ): Promise<PriorClosedConversation | undefined>;

  /**
   * Create a held boundary-prompt row. `bufferedInbounds` carries the first
   * inbound that triggered the hold; subsequent arrivals append via
   * `appendBoundaryBuffer`. The UNIQUE (channel_id, platform_address)
   * constraint surfaces concurrent attempts as a constraint violation —
   * callers handle that via `getBoundaryPendingByAddress` first.
   */
  createBoundaryPending(
    tx: Transaction,
    params: {
      channelId: string;
      platformAddress: string;
      platformUserHandle: string;
      priorConversationId: string;
      promptMessageId: string;
      bufferedInbounds: ReadonlyArray<BufferedInboundEntry>;
      expiresAt: Date;
    },
  ): Promise<{ id: string }>;

  /** Fetch a pending boundary for the given chat, or undefined when none. */
  getBoundaryPendingByAddress(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
  ): Promise<BoundaryPendingRow | undefined>;

  /** Fetch by primary key — used by the resolve path after a callback tap. */
  getBoundaryPendingById(tx: Transaction, id: string): Promise<BoundaryPendingRow | undefined>;

  /**
   * Append a buffered inbound to an existing hold. Single SQL UPDATE using
   * Postgres' JSONB `||` operator — no read-modify-write, so concurrent
   * appends on the same row don't race regardless of isolation level or
   * caller assumptions about per-chat mutexes. Safe under webhook
   * deployments and multi-process adapters that bypass the in-process
   * dispatch mutex.
   */
  appendBoundaryBuffer(tx: Transaction, id: string, entry: BufferedInboundEntry): Promise<void>;

  /** Delete a resolved boundary row. */
  deleteBoundaryPending(tx: Transaction, id: string): Promise<void>;

  /**
   * Boundary rows whose `expires_at` is older than `cutoff`. The janitor
   * cron passes `cutoff = now() - grace` so it only sees rows the
   * in-flight waiter has had time to handle. Returned rows carry
   * `channelId` because `resolveBoundary` needs to know which channel's
   * deps closure to use (the janitor runs across all channels).
   */
  listExpiredBoundaryPending(
    tx: Transaction,
    cutoff: Date,
  ): Promise<ReadonlyArray<{ id: string; channelId: string; platformAddress: string }>>;
}

/**
 * Render a one-line excerpt of a `messages.content` value for UI labels.
 * Strings are truncated directly; ContentBlock arrays surface the first
 * text block's prefix. Non-text-only content (image-only turn, etc.)
 * resolves to `null` — the caller should fall back to alias or timestamp.
 */
function snippetFromMessageContent(
  content: string | ReadonlyArray<{ type: string; text?: string }>,
  maxChars: number,
): string | null {
  if (typeof content === "string") {
    return truncate(content.trim(), maxChars);
  }
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      const trimmed = block.text.trim();
      if (trimmed.length > 0) return truncate(trimmed, maxChars);
    }
  }
  return null;
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(1, maxChars - 1))}…`;
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
      status: ChannelSessionStatus;
      receive: ChannelSessionReceive;
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
      status: ChannelSessionStatus;
      receive: ChannelSessionReceive;
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

  async persistInbound(tx: Transaction, params: PersistInboundParams): Promise<{ id: string }> {
    const row =
      params.source === "user"
        ? {
            source: "user" as const,
            channelSessionId: params.channelSessionId,
            conversationId: params.conversationId,
            content: params.content,
            platformTs: params.platformTs,
          }
        : {
            source: "scheduled" as const,
            scheduledFireKey: params.scheduledFireKey,
            conversationId: params.conversationId,
            content: params.content,
            platformTs: params.platformTs,
          };
    return single(
      await tx.insert(inboundMessages).values(row).returning({ id: inboundMessages.id }),
    );
  }

  async findInboundByScheduledFireKey(
    tx: Transaction,
    scheduledFireKey: string,
  ): Promise<{ id: string; conversationId: string } | undefined> {
    const rows = await tx
      .select({ id: inboundMessages.id, conversationId: inboundMessages.conversationId })
      .from(inboundMessages)
      .where(eq(inboundMessages.scheduledFireKey, scheduledFireKey))
      .limit(1);
    return rows[0];
  }

  async getUnbatchedInbound(
    tx: Transaction,
    conversationId: string,
    afterId: string | null,
  ): Promise<ReadonlyArray<{ id: string; content: InboundContent; source: InboundMessageSource }>> {
    const conditions = [eq(inboundMessages.conversationId, conversationId)];
    if (afterId) {
      conditions.push(gt(inboundMessages.id, afterId));
    }
    return tx
      .select({
        id: inboundMessages.id,
        content: inboundMessages.content,
        source: inboundMessages.source,
      })
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

  async peekPriorClosedConversation(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
    minUserTurns: number,
    snippetMaxChars: number,
  ): Promise<PriorClosedConversation | undefined> {
    // Most-recent session on this address — closed or otherwise. The caller
    // only invokes this after resolveSession returned null, so any active
    // row here means the resolveSession safety-net hasn't closed the stale
    // session yet (rare race); treat that as "no prior worth surfacing"
    // rather than fight the half-state.
    const sessionRows = await tx
      .select({
        conversationId: channelSessions.conversationId,
        status: channelSessions.status,
      })
      .from(channelSessions)
      .where(
        and(
          eq(channelSessions.channelId, channelId),
          eq(channelSessions.platformAddress, platformAddress),
        ),
      )
      .orderBy(desc(channelSessions.id))
      .limit(1);
    const prior = sessionRows[0];
    if (!prior || prior.status === "active") return undefined;

    const conversationId = prior.conversationId;

    const userCountRows = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")));
    const userTurnCount = userCountRows[0]?.value ?? 0;
    if (userTurnCount < minUserTurns) return undefined;

    const lastMsgRows = await tx
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.id))
      .limit(1);
    const lastMessageAt = lastMsgRows[0]?.createdAt ?? null;

    const aliasRows = await tx
      .select({ alias: aliases.alias })
      .from(aliases)
      .where(eq(aliases.conversationId, conversationId))
      .limit(1);
    const alias = aliasRows[0]?.alias ?? null;

    const firstRows = await tx
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")))
      .orderBy(messages.id)
      .limit(1);
    const firstUserSnippet = firstRows[0]
      ? snippetFromMessageContent(firstRows[0].content, snippetMaxChars)
      : null;

    return {
      conversationId,
      userTurnCount,
      lastMessageAt,
      alias,
      firstUserSnippet,
    };
  }

  async createBoundaryPending(
    tx: Transaction,
    params: {
      channelId: string;
      platformAddress: string;
      platformUserHandle: string;
      priorConversationId: string;
      promptMessageId: string;
      bufferedInbounds: ReadonlyArray<BufferedInboundEntry>;
      expiresAt: Date;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(boundaryPending)
        .values({
          channelId: params.channelId,
          platformAddress: params.platformAddress,
          platformUserHandle: params.platformUserHandle,
          priorConversationId: params.priorConversationId,
          promptMessageId: params.promptMessageId,
          bufferedInbounds: [...params.bufferedInbounds],
          expiresAt: params.expiresAt,
        })
        .returning({ id: boundaryPending.id }),
    );
  }

  async getBoundaryPendingByAddress(
    tx: Transaction,
    channelId: string,
    platformAddress: string,
  ): Promise<BoundaryPendingRow | undefined> {
    const rows = await tx
      .select()
      .from(boundaryPending)
      .where(
        and(
          eq(boundaryPending.channelId, channelId),
          eq(boundaryPending.platformAddress, platformAddress),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async getBoundaryPendingById(
    tx: Transaction,
    id: string,
  ): Promise<BoundaryPendingRow | undefined> {
    const rows = await tx.select().from(boundaryPending).where(eq(boundaryPending.id, id)).limit(1);
    return rows[0];
  }

  async appendBoundaryBuffer(
    tx: Transaction,
    id: string,
    entry: BufferedInboundEntry,
  ): Promise<void> {
    // Atomic JSONB-array concatenation: `existing || [entry]`. Postgres
    // resolves this on the server side — no select-then-update window,
    // race-free regardless of isolation level. UPDATE on a missing id
    // matches zero rows and is a no-op (matches the prior
    // getBoundaryPendingById-then-skip behaviour).
    await tx
      .update(boundaryPending)
      .set({
        bufferedInbounds: sql`${boundaryPending.bufferedInbounds} || ${JSON.stringify([entry])}::jsonb`,
      })
      .where(eq(boundaryPending.id, id));
  }

  async deleteBoundaryPending(tx: Transaction, id: string): Promise<void> {
    await tx.delete(boundaryPending).where(eq(boundaryPending.id, id));
  }

  async listExpiredBoundaryPending(
    tx: Transaction,
    cutoff: Date,
  ): Promise<ReadonlyArray<{ id: string; channelId: string; platformAddress: string }>> {
    return tx
      .select({
        id: boundaryPending.id,
        channelId: boundaryPending.channelId,
        platformAddress: boundaryPending.platformAddress,
      })
      .from(boundaryPending)
      .where(lt(boundaryPending.expiresAt, cutoff));
  }

  async findReachableChannelsForUserProfile(
    tx: Transaction,
    userId: string,
    profileId: string,
  ): Promise<ReadonlyArray<ReachableChannel>> {
    // `status` is intentionally not filtered — closed sessions still
    // carry a reachable `(channelId, platformAddress)` and the rotation
    // overwrites them with a fresh active row. The `expires_at` filter
    // does apply: a Web UI client whose heartbeat stopped is unreachable.
    //
    // The notExists clause excludes addresses currently bound to an
    // active session on a different profile for the same user. Without
    // it, rotation would `swapSession` over the user's in-flight
    // conversation on another profile, silently hijacking their context
    // to the scheduled fire's profile. Self-joining the same tables
    // requires aliases (`other_cs`, `other_conv`).
    const otherCs = alias(channelSessions, "other_cs");
    const otherConv = alias(conversations, "other_conv");
    return tx
      .selectDistinctOn([channelSessions.channelId, channelSessions.platformAddress], {
        channelId: channelSessions.channelId,
        platformAddress: channelSessions.platformAddress,
        receive: channelSessions.receive,
      })
      .from(channelSessions)
      .innerJoin(conversations, eq(conversations.id, channelSessions.conversationId))
      .where(
        and(
          eq(conversations.userId, userId),
          eq(conversations.profileId, profileId),
          or(isNull(channelSessions.expiresAt), gt(channelSessions.expiresAt, sql`now()`)),
          notExists(
            tx
              .select({ x: sql<number>`1` })
              .from(otherCs)
              .innerJoin(otherConv, eq(otherConv.id, otherCs.conversationId))
              .where(
                and(
                  eq(otherCs.channelId, channelSessions.channelId),
                  eq(otherCs.platformAddress, channelSessions.platformAddress),
                  eq(otherCs.status, "active"),
                  eq(otherConv.userId, userId),
                  ne(otherConv.profileId, profileId),
                ),
              ),
          ),
        ),
      )
      .orderBy(
        channelSessions.channelId,
        channelSessions.platformAddress,
        desc(channelSessions.id),
      );
  }
}
