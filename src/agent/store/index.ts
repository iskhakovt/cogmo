import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import type { JsonValue } from "type-fest";
import { single } from "../../db/helpers.js";
import type { Database } from "../../db/index.js";
import {
  conversations,
  coreMemoryBlocks,
  llmProviders,
  messages,
  profiles,
  steeringRules,
  users,
} from "./schema.js";

export interface AgentStore {
  /** Create a new user. */
  createUser(): Promise<{ id: string }>;

  /** Create a new conversation. */
  createConversation(params: {
    userId: string;
    profileId: string;
    isPrivate: boolean;
  }): Promise<{ id: string }>;

  /** Load a conversation by ID. */
  getConversation(
    conversationId: string,
  ): Promise<{ id: string; userId: string; profileId: string; isPrivate: boolean } | null>;

  /** Insert a message (user or assistant). Returns the new message ID. */
  insertMessage(params: {
    conversationId: string;
    role: "user" | "assistant";
    content: JsonValue;
    lastInboundMessageId: string;
    inputTokens?: number;
  }): Promise<{ id: string }>;

  /** Get the most recent assistant message for a conversation (for cursor chain). */
  getLastAssistantMessage(
    conversationId: string,
  ): Promise<{ id: string; lastInboundMessageId: string } | null>;

  /** Load full message history for a conversation, ordered by id. */
  getHistory(
    conversationId: string,
  ): Promise<ReadonlyArray<{ role: "user" | "assistant"; content: JsonValue }>>;

  /** Load a profile by ID. */
  getProfile(profileId: string): Promise<{
    id: string;
    basePrompt: string;
    model: string;
    toolSet: JsonValue;
    providerId: string | null;
  } | null>;

  /** Get the first user (for bootstrapping). */
  getFirstUser(): Promise<{ id: string } | null>;

  /** Get the first profile (for bootstrapping). */
  getDefaultProfile(): Promise<{ id: string } | null>;

  /** Create a profile. */
  createProfile(params: {
    name: string;
    basePrompt: string;
    model: string;
    toolSet: JsonValue;
  }): Promise<{ id: string }>;

  /** Load a single message by ID. */
  getMessage(messageId: string): Promise<{ id: string; role: string; content: JsonValue } | null>;

  /** Load active steering rules for a profile (global + profile-specific, ordered by priority). */
  getActiveRules(profileId: string): Promise<ReadonlyArray<{ rule: string }>>;

  /** Get all core memory blocks for a user, ordered by key. */
  getCoreMemoryBlocks(userId: string): Promise<ReadonlyArray<{ key: string; content: string }>>;

  /** Upsert a core memory block. Creates if key doesn't exist, updates if it does. */
  upsertCoreMemoryBlock(params: { userId: string; key: string; content: string }): Promise<void>;

  /** Get the timestamp of the most recent message in a conversation (any role). */
  getLastMessageTime(conversationId: string): Promise<Date | null>;

  /** Get inputTokens from the most recent assistant message (for fast-path budget estimation). */
  getLastInputTokens(conversationId: string): Promise<number | null>;

  // --- LLM Providers ---

  /** Create an LLM provider configuration. */
  createProvider(params: {
    name: string;
    type: string;
    baseUrl?: string;
    secretId: string;
    attrs: JsonValue;
    isValid: boolean;
  }): Promise<{ id: string }>;

  /** Get a provider by ID. */
  getProvider(providerId: string): Promise<{
    id: string;
    name: string;
    type: string;
    baseUrl: string | null;
    secretId: string;
    attrs: JsonValue;
    isValid: boolean;
  } | null>;

  /** Get the provider linked to a profile (via provider_id FK). */
  getProfileProvider(profileId: string): Promise<{
    id: string;
    name: string;
    type: string;
    baseUrl: string | null;
    secretId: string;
    attrs: JsonValue;
  } | null>;

  /** Link a profile to a provider. */
  setProfileProvider(profileId: string, providerId: string): Promise<void>;

  /** List all providers. */
  listProviders(): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: string;
      isValid: boolean;
      validatedAt: Date | null;
    }>
  >;

  /** Delete a provider by ID. */
  deleteProvider(providerId: string): Promise<void>;
}

export class DrizzleAgentStore implements AgentStore {
  #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }

  async createUser(): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
      return single(await tx.insert(users).values({}).returning({ id: users.id }));
    });
  }

  async createConversation(params: {
    userId: string;
    profileId: string;
    isPrivate: boolean;
  }): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
      return single(
        await tx.insert(conversations).values(params).returning({ id: conversations.id }),
      );
    });
  }

  async getConversation(
    conversationId: string,
  ): Promise<{ id: string; userId: string; profileId: string; isPrivate: boolean } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: conversations.id,
          userId: conversations.userId,
          profileId: conversations.profileId,
          isPrivate: conversations.isPrivate,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async insertMessage(params: {
    conversationId: string;
    role: "user" | "assistant";
    content: JsonValue;
    lastInboundMessageId: string;
    inputTokens?: number;
  }): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
      return single(
        await tx
          .insert(messages)
          .values({
            conversationId: params.conversationId,
            role: params.role,
            content: params.content,
            lastInboundMessageId: params.lastInboundMessageId,
            ...(params.inputTokens != null && { inputTokens: params.inputTokens }),
          })
          .returning({ id: messages.id }),
      );
    });
  }

  async getLastAssistantMessage(
    conversationId: string,
  ): Promise<{ id: string; lastInboundMessageId: string } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: messages.id,
          lastInboundMessageId: messages.lastInboundMessageId,
        })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
        .orderBy(desc(messages.id))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async getHistory(
    conversationId: string,
  ): Promise<ReadonlyArray<{ role: "user" | "assistant"; content: JsonValue }>> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.id));
      return rows as ReadonlyArray<{ role: "user" | "assistant"; content: JsonValue }>;
    });
  }

  async getProfile(profileId: string): Promise<{
    id: string;
    basePrompt: string;
    model: string;
    toolSet: JsonValue;
    providerId: string | null;
  } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: profiles.id,
          basePrompt: profiles.basePrompt,
          model: profiles.model,
          toolSet: profiles.toolSet,
          providerId: profiles.providerId,
        })
        .from(profiles)
        .where(eq(profiles.id, profileId))
        .limit(1);
      return (
        (rows[0] as {
          id: string;
          basePrompt: string;
          model: string;
          toolSet: JsonValue;
          providerId: string | null;
        }) ?? null
      );
    });
  }

  async getFirstUser(): Promise<{ id: string } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select({ id: users.id }).from(users).limit(1);
      return rows[0] ?? null;
    });
  }

  async getDefaultProfile(): Promise<{ id: string } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select({ id: profiles.id }).from(profiles).limit(1);
      return rows[0] ?? null;
    });
  }

  async createProfile(params: {
    name: string;
    basePrompt: string;
    model: string;
    toolSet: JsonValue;
  }): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
      return single(await tx.insert(profiles).values(params).returning({ id: profiles.id }));
    });
  }

  async getMessage(
    messageId: string,
  ): Promise<{ id: string; role: string; content: JsonValue } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: messages.id, role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1);
      return (rows[0] as { id: string; role: string; content: JsonValue }) ?? null;
    });
  }

  async getActiveRules(profileId: string): Promise<ReadonlyArray<{ rule: string }>> {
    return this.#db.transaction(async (tx) => {
      return tx
        .select({ rule: steeringRules.rule })
        .from(steeringRules)
        .where(
          and(
            eq(steeringRules.active, true),
            or(isNull(steeringRules.profileId), eq(steeringRules.profileId, profileId)),
          ),
        )
        .orderBy(asc(steeringRules.priority));
    });
  }

  async getCoreMemoryBlocks(
    userId: string,
  ): Promise<ReadonlyArray<{ key: string; content: string }>> {
    return this.#db.transaction(async (tx) => {
      return tx
        .select({ key: coreMemoryBlocks.key, content: coreMemoryBlocks.content })
        .from(coreMemoryBlocks)
        .where(eq(coreMemoryBlocks.userId, userId))
        .orderBy(asc(coreMemoryBlocks.key));
    });
  }

  async upsertCoreMemoryBlock(params: {
    userId: string;
    key: string;
    content: string;
  }): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .insert(coreMemoryBlocks)
        .values(params)
        .onConflictDoUpdate({
          target: [coreMemoryBlocks.userId, coreMemoryBlocks.key],
          set: { content: params.content, updatedAt: new Date() },
        });
    });
  }

  async getLastInputTokens(conversationId: string): Promise<number | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ inputTokens: messages.inputTokens })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
        .orderBy(desc(messages.id))
        .limit(1);
      return rows[0]?.inputTokens ?? null;
    });
  }

  async getLastMessageTime(conversationId: string): Promise<Date | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.id))
        .limit(1);
      return rows[0]?.createdAt ?? null;
    });
  }

  // --- LLM Providers ---

  async createProvider(params: {
    name: string;
    type: string;
    baseUrl?: string;
    secretId: string;
    attrs: JsonValue;
    isValid: boolean;
  }): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
      return single(
        await tx
          .insert(llmProviders)
          .values({
            name: params.name,
            type: params.type,
            baseUrl: params.baseUrl,
            secretId: params.secretId,
            attrs: params.attrs,
            isValid: params.isValid,
          })
          .returning({ id: llmProviders.id }),
      );
    });
  }

  async getProvider(providerId: string): Promise<{
    id: string;
    name: string;
    type: string;
    baseUrl: string | null;
    secretId: string;
    attrs: JsonValue;
    isValid: boolean;
  } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: llmProviders.id,
          name: llmProviders.name,
          type: llmProviders.type,
          baseUrl: llmProviders.baseUrl,
          secretId: llmProviders.secretId,
          attrs: llmProviders.attrs,
          isValid: llmProviders.isValid,
        })
        .from(llmProviders)
        .where(eq(llmProviders.id, providerId))
        .limit(1);
      return (rows[0] as (typeof rows)[0] & { attrs: JsonValue }) ?? null;
    });
  }

  async getProfileProvider(profileId: string): Promise<{
    id: string;
    name: string;
    type: string;
    baseUrl: string | null;
    secretId: string;
    attrs: JsonValue;
  } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: llmProviders.id,
          name: llmProviders.name,
          type: llmProviders.type,
          baseUrl: llmProviders.baseUrl,
          secretId: llmProviders.secretId,
          attrs: llmProviders.attrs,
        })
        .from(profiles)
        .innerJoin(llmProviders, eq(profiles.providerId, llmProviders.id))
        .where(eq(profiles.id, profileId))
        .limit(1);
      return (rows[0] as (typeof rows)[0] & { attrs: JsonValue }) ?? null;
    });
  }

  async setProfileProvider(profileId: string, providerId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(profiles).set({ providerId }).where(eq(profiles.id, profileId));
    });
  }

  async listProviders(): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: string;
      isValid: boolean;
      validatedAt: Date | null;
    }>
  > {
    return this.#db.transaction(async (tx) => {
      return tx
        .select({
          id: llmProviders.id,
          name: llmProviders.name,
          type: llmProviders.type,
          isValid: llmProviders.isValid,
          validatedAt: llmProviders.validatedAt,
        })
        .from(llmProviders);
    });
  }

  async deleteProvider(providerId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.delete(llmProviders).where(eq(llmProviders.id, providerId));
    });
  }
}
