import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// --- Enums ---

export const messageRole = pgEnum("message_role", ["user", "assistant"]);
export const deliveryDirection = pgEnum("delivery_direction", ["inbound", "outbound"]);
export const deliveryStatus = pgEnum("delivery_status", ["pending", "sent", "delivered", "failed"]);
export const inboundStatus = pgEnum("inbound_status", ["pending", "processing", "processed"]);
export const ruleCategory = pgEnum("rule_category", ["safety", "style", "domain", "memory"]);
export const ruleSource = pgEnum("rule_source", [
  "manual",
  "correction",
  "signal_pipeline",
  "evolution",
]);

// --- Shared column helpers ---

function pk() {
  return uuid("id").primaryKey().default(sql`uuidv7()`);
}

function ts() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

// --- Tables ---

export const users = pgTable("users", {
  id: pk(),
  createdAt: ts(),
});

export const profiles = pgTable(
  "profiles",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    basePrompt: text("base_prompt").notNull(),
    model: text("model").notNull(),
    toolSet: jsonb("tool_set"),
    createdAt: ts(),
  },
  (t) => [unique("uq_profiles_user_name").on(t.userId, t.name)],
);

export const conversations = pgTable("conversations", {
  id: pk(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  profileId: uuid("profile_id")
    .notNull()
    .references(() => profiles.id),
  createdAt: ts(),
});

export const chats = pgTable("chats", {
  id: pk(),
  address: jsonb("address").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  conversationId: uuid("conversation_id").references(() => conversations.id),
  createdAt: ts(),
});

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: messageRole().notNull(),
    content: jsonb("content").notNull(),
    createdAt: ts(),
  },
  (t) => [index("idx_messages_conv_time").on(t.conversationId, t.createdAt)],
);

export const inboundMessages = pgTable("inbound_messages", {
  id: pk(),
  chatId: uuid("chat_id")
    .notNull()
    .references(() => chats.id),
  content: jsonb("content").notNull(),
  status: inboundStatus().notNull().default("pending"),
  messageId: uuid("message_id").references(() => messages.id),
  createdAt: ts(),
});

export const deliveries = pgTable("deliveries", {
  id: pk(),
  messageId: uuid("message_id")
    .notNull()
    .references(() => messages.id),
  chatId: uuid("chat_id")
    .notNull()
    .references(() => chats.id),
  direction: deliveryDirection().notNull(),
  status: deliveryStatus().notNull().default("pending"),
  createdAt: ts(),
});

export const steeringRules = pgTable("steering_rules", {
  id: pk(),
  rule: text("rule").notNull(),
  category: ruleCategory().notNull(),
  active: boolean("active").notNull().default(true),
  source: ruleSource().notNull(),
  priority: integer("priority").notNull().default(0),
  observationCount: integer("observation_count").default(1),
  profileId: uuid("profile_id").references(() => profiles.id),
  createdAt: ts(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
