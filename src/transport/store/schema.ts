import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { conversations, profiles, users } from "../../agent/store/schema.js";
import { jsonbZod, pk, ts } from "../../db/helpers.js";
import { InboundContentSchema } from "../content.js";

/**
 * `channel_sessions.status` records reachability — whether we can deliver
 * to the user on this channel right now. See design/transport/sessions.md.
 */
export const channelSessionStatus = pgEnum("channel_session_status", ["active", "closed"]);
export type ChannelSessionStatus = (typeof channelSessionStatus.enumValues)[number];

/**
 * `channel_sessions.receive` — which responses this session gets.
 * `routed` is normal source/lastInbound routing; `all` is Web-UI-style
 * "watch everything" (private only); `none` is input-only (muted).
 */
export const channelSessionReceive = pgEnum("channel_session_receive", ["none", "routed", "all"]);
export type ChannelSessionReceive = (typeof channelSessionReceive.enumValues)[number];

/**
 * `inbound_messages.source` — `user` for platform-delivered messages
 * (originating session FK populated), `scheduled` for synthetic inbounds
 * with no originating session. A check constraint enforces the link.
 */
export const inboundMessageSource = pgEnum("inbound_message_source", ["user", "scheduled"]);
export type InboundMessageSource = (typeof inboundMessageSource.enumValues)[number];

export const channels = pgTable("channels", {
  id: pk(),
  type: text("type").notNull(), // 'telegram' | 'cli' | 'slack' | 'web'
  // OPAQUE — encrypted ciphertext or plaintext credentials handed back to the
  // adapter SDK unchanged (Telegram bot token, OAuth bundle, etc.). Cogmo
  // never inspects the contents, so it stays raw `jsonb` rather than being
  // gated by a Zod schema (CLAUDE.md JSONB rule explicitly exempts opaque
  // payloads).
  credentials: jsonb("credentials").notNull(),
  identityMode: text("identity_mode").notNull(), // 'fixed' | 'mapped' | 'create'
  /**
   * Per-channel cap on TTS reply length. Above the cap, the orchestrator
   * skips TTS and sends a "(too long for voice)" follow-up note instead;
   * the streamed text reply is unaffected. Default 700 chars ≈ 60s of
   * speech at conversational pace. See design/voice.md.
   */
  voiceMaxReplyChars: integer("voice_max_reply_chars").notNull().default(700),
  createdAt: ts(),
});

export const channelSessions = pgTable(
  "channel_sessions",
  {
    id: pk(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id),
    platformAddress: text("platform_address").notNull(), // opaque, channel-specific
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    status: channelSessionStatus("status").notNull(),
    receive: channelSessionReceive("receive").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }), // NULL = never expires
    createdAt: ts(),
  },
  (t) => [
    index("idx_sessions_channel_address").on(t.channelId, t.platformAddress, t.id),
    index("idx_sessions_receive_all")
      .on(t.conversationId)
      .where(sql`status = 'active' AND receive = 'all'`),
  ],
);

export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: pk(),
    // Nullable: `source='scheduled'` rows have no originating session.
    // The check constraint below ties nullability to `source`.
    channelSessionId: uuid("channel_session_id").references(() => channelSessions.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id), // denormalized for query performance
    content: jsonbZod("content", InboundContentSchema).notNull(),
    platformTs: timestamp("platform_ts", { withTimezone: true }).notNull(), // when the user sent it
    source: inboundMessageSource("source").notNull(),
    /**
     * Idempotency key for scheduled fires: `${taskId}:${scheduledFor}` —
     * matches the Inngest event-bus dedup key on the ticker's fan-out.
     * The fire-handler pre-checks this on every dispatch so a retry that
     * lands after a successful commit (worker died between tx commit and
     * Inngest ack) reuses the existing row instead of rotating again.
     * NULL for `source='user'`; the check constraint enforces the link.
     */
    scheduledFireKey: text("scheduled_fire_key"),
    createdAt: ts(),
  },
  (t) => [
    uniqueIndex("uq_inbound_scheduled_fire_key")
      .on(t.scheduledFireKey)
      .where(sql`scheduled_fire_key IS NOT NULL`),
    check(
      "chk_inbound_source_session",
      sql`(${t.source} = 'user' AND ${t.channelSessionId} IS NOT NULL AND ${t.scheduledFireKey} IS NULL)
        OR (${t.source} = 'scheduled' AND ${t.channelSessionId} IS NULL AND ${t.scheduledFireKey} IS NOT NULL)`,
    ),
  ],
);

/**
 * Per-chat default profile. Keyed on `(channel_id, platform_address)` —
 * one row per Telegram chat / Direct address / etc. When set, new
 * conversations on that chat use this profile unless the caller passed an
 * explicit `profileId`. Falls back to the global `defaultProfileId` baked
 * into the Transport when no row exists.
 *
 * Set via `/profile default <name>` and cleared via `/profile default clear`
 * in the Telegram adapter; the row is upserted on set and deleted on clear.
 *
 * Both FKs are `ON DELETE CASCADE`: deleting a channel sweeps its defaults
 * with it, and deleting a profile silently unpins any chats using it as
 * default (the binding is ephemeral preference, not historical data — the
 * affected chats fall back to the global default on the next `createConv`).
 */
export const chatDefaultProfiles = pgTable(
  "chat_default_profiles",
  {
    id: pk(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    platformAddress: text("platform_address").notNull(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    createdAt: ts(),
  },
  (t) => [unique("uq_chat_default_profiles").on(t.channelId, t.platformAddress)],
);

export const userIdentities = pgTable(
  "user_identities",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id),
    platformHandle: text("platform_handle"), // NULL for wildcard entries
    isWildcard: boolean("is_wildcard").notNull(), // true ⟺ platform_handle IS NULL
    autoCreated: boolean("auto_created").notNull(),
    createdAt: ts(),
  },
  (t) => [
    unique("uq_identities_channel_handle").on(t.channelId, t.platformHandle).nullsNotDistinct(),
    check("chk_wildcard_handle", sql`is_wildcard = (platform_handle IS NULL)`),
  ],
);
