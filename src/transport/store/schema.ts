import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { conversations, users } from "../../agent/store/schema.js";
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
