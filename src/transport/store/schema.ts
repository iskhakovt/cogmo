import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { conversations, profiles, users } from "../../agent/store/schema.js";
import { jsonbZod, pk, ts } from "../../db/helpers.js";
import { InboundContentSchema } from "../content.js";

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
    status: text("status").notNull(), // 'active' | 'closed'
    receive: text("receive").notNull(), // 'none' | 'routed' | 'all'
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

export const inboundMessages = pgTable("inbound_messages", {
  id: pk(),
  channelSessionId: uuid("channel_session_id")
    .notNull()
    .references(() => channelSessions.id),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id), // denormalized for query performance
  content: jsonbZod("content", InboundContentSchema).notNull(),
  platformTs: timestamp("platform_ts", { withTimezone: true }).notNull(), // when the user sent it
  createdAt: ts(),
});

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
