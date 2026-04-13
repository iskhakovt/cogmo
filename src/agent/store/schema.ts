import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { pk, ts } from "../../db/helpers.js";
import { secrets } from "../../secrets/store/schema.js";

// --- Tables ---

export const users = pgTable("users", {
  id: pk(),
  createdAt: ts(),
});

export const llmProviders = pgTable("llm_providers", {
  id: pk(),
  name: text("name").notNull().unique(),
  type: text("type").notNull(), // 'anthropic' | 'openai_compatible'
  baseUrl: text("base_url"), // NULL = SDK default endpoint
  secretId: uuid("secret_id")
    .notNull()
    .references(() => secrets.id),
  attrs: jsonb("attrs").notNull(), // { promptCaching?: boolean, headers?: Record<string, string> }
  createdAt: ts(),
});

/** For a given model, which providers can serve it and in what order. */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: pk(),
    model: text("model").notNull(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => llmProviders.id, { onDelete: "cascade" }),
    position: integer("position").notNull(), // 0 = primary, 1 = first fallback, ...
    createdAt: ts(),
  },
  (t) => [
    unique("uq_model_provider").on(t.model, t.providerId),
    unique("uq_model_position").on(t.model, t.position),
  ],
);

export const profiles = pgTable(
  "profiles",
  {
    id: pk(),
    name: text("name").notNull(),
    basePrompt: text("base_prompt").notNull(),
    model: text("model").notNull(),
    summarizationModel: text("summarization_model"), // null = use main model
    extractionModel: text("extraction_model"), // null = use main model
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
    inputTokens: integer("input_tokens"), // nullable — only set on assistant messages
    createdAt: ts(),
  },
  (t) => [index("idx_messages_conv_id").on(t.conversationId, t.id)],
);

export const coreMemoryBlocks = pgTable(
  "core_memory_blocks",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    key: text("key").notNull(), // 'user_profile', 'active_projects', etc.
    content: text("content").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: ts(),
  },
  (t) => [unique("uq_core_memory_user_key").on(t.userId, t.key)],
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
