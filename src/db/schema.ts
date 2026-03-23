import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// --- Phase 1: Conversations ---

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(), // cuid2
  channel: text("channel").notNull(), // 'telegram' | 'cli' | 'api'
  userId: text("user_id").notNull(), // channel-specific user ID
  cursor: text("cursor"), // last processed message ID (crash recovery)
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }), // NULL = active
  metadata: jsonb("metadata"), // extensible per-conversation data
});

// --- Phase 1: Messages ---

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role").notNull(), // 'user' | 'assistant' | 'tool_result'
    content: jsonb("content").notNull(), // Anthropic SDK message content blocks
    model: text("model"), // which model generated this (NULL for user messages)
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata"),
  },
  (t) => [index("idx_messages_conv_time").on(t.conversationId, t.createdAt)],
);

// --- Phase 1: Steering Rules ---

export const steeringRules = pgTable("steering_rules", {
  id: serial("id").primaryKey(),
  rule: text("rule").notNull(),
  category: text("category").notNull(), // 'safety' | 'style' | 'domain' | 'memory'
  active: boolean("active").notNull().default(true),
  source: text("source"), // 'manual' | 'correction' | 'signal_pipeline'
  priority: integer("priority").notNull().default(0), // ordering in system prompt
  observationCount: integer("observation_count").default(1), // rule graduation (2+ = promoted)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
