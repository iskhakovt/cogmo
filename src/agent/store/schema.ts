import { boolean, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { pk, ts } from "../../db/helpers.js";

// --- Tables ---

export const users = pgTable("users", {
  id: pk(),
  createdAt: ts(),
});

export const profiles = pgTable(
  "profiles",
  {
    id: pk(),
    name: text("name").notNull(),
    basePrompt: text("base_prompt").notNull(),
    model: text("model").notNull(),
    toolSet: jsonb("tool_set").notNull(),
    createdAt: ts(),
  },
  (t) => [unique("uq_profiles_name").on(t.name)],
);

export const conversations = pgTable("conversations", {
  id: pk(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  profileId: uuid("profile_id")
    .notNull()
    .references(() => profiles.id),
  isPrivate: boolean("is_private").notNull(),
  createdAt: ts(),
});

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: jsonb("content").notNull(),
    lastInboundMessageId: uuid("last_inbound_message_id").notNull(),
    createdAt: ts(),
  },
  (t) => [index("idx_messages_conv_id").on(t.conversationId, t.id)],
);

export const steeringRules = pgTable("steering_rules", {
  id: pk(),
  rule: text("rule").notNull(),
  category: text("category").notNull(), // 'safety' | 'style' | 'domain' | 'memory'
  active: boolean("active").notNull(),
  source: text("source").notNull(), // 'manual' | 'correction' | 'signal_pipeline' | 'evolution'
  priority: integer("priority").notNull(),
  observationCount: integer("observation_count").notNull(),
  profileId: uuid("profile_id").references(() => profiles.id), // NULL = applies to all profiles
  createdAt: ts(),
});
