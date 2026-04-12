import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import * as R from "remeda";
import type { JsonValue } from "type-fest";
import { single } from "../../db/helpers.js";
import type { Database } from "../../db/index.js";
import { type ContentBlock, type Message, MessageContentSchema } from "../../llm/types.js";
import {
  conversations,
  coreMemoryBlocks,
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
    content: string | ContentBlock[];
    lastInboundMessageId: string;
    inputTokens?: number;
  }): Promise<{ id: string }>;

  /** Insert multiple messages atomically in a single transaction. Returns the last inserted ID. */
  insertMessages(params: {
    conversationId: string;
    messages: ReadonlyArray<Message>;
    lastInboundMessageId: string;
    lastMessageInputTokens?: number;
  }): Promise<{ id: string }>;

  /** Get the most recent assistant message for a conversation (for cursor chain). */
  getLastAssistantMessage(
    conversationId: string,
  ): Promise<{ id: string; lastInboundMessageId: string } | null>;

  /** Load full message history for a conversation, ordered by id. */
  getHistory(conversationId: string): Promise<ReadonlyArray<Message>>;

  /** Load a profile by ID. */
  getProfile(
    profileId: string,
  ): Promise<{ id: string; basePrompt: string; model: string; toolSet: JsonValue } | null>;

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
  getMessage(
    messageId: string,
  ): Promise<{ id: string; role: string; content: string | ContentBlock[] } | null>;

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

  // --- Evolution: correction extraction ---

  /** Get all correction-sourced rules (active + inactive) for dedup during extraction. */
  getCorrections(profileId: string): Promise<
    ReadonlyArray<{
      id: string;
      rule: string;
      category: string;
      active: boolean;
      observationCount: number;
    }>
  >;

  /** Insert a new correction or increment an existing one. Promotes to active when observationCount reaches 2. */
  upsertCorrection(params: {
    rule: string;
    category: string;
    profileId: string | null;
    existingRuleId?: string;
  }): Promise<{ id: string; promoted: boolean }>;

  /** Count active steering rules for a profile (global + profile-specific). */
  countActiveRules(profileId: string): Promise<number>;

  /** Atomically replace a set of old rules with a single consolidated rule. */
  replaceRules(params: {
    oldIds: string[];
    newRule: {
      rule: string;
      category: string;
      profileId: string | null;
      priority: number;
      observationCount: number;
    };
  }): Promise<{ id: string }>;
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
    content: string | ContentBlock[];
    lastInboundMessageId: string;
    inputTokens?: number;
  }): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
      const content = MessageContentSchema.parse(params.content);
      return single(
        await tx
          .insert(messages)
          .values({
            conversationId: params.conversationId,
            role: params.role,
            content,
            lastInboundMessageId: params.lastInboundMessageId,
            ...(params.inputTokens != null && { inputTokens: params.inputTokens }),
          })
          .returning({ id: messages.id }),
      );
    });
  }

  async insertMessages(params: {
    conversationId: string;
    messages: ReadonlyArray<Message>; // must be non-empty
    lastInboundMessageId: string;
    lastMessageInputTokens?: number;
  }): Promise<{ id: string }> {
    if (params.messages.length === 0) {
      throw new Error("insertMessages requires at least one message");
    }
    return this.#db.transaction(async (tx) => {
      const lastIdx = params.messages.length - 1;
      const values = R.map(params.messages, (msg, i) => ({
        conversationId: params.conversationId,
        role: msg.role,
        content: MessageContentSchema.parse(msg.content),
        lastInboundMessageId: params.lastInboundMessageId,
        ...(i === lastIdx &&
          params.lastMessageInputTokens != null && {
            inputTokens: params.lastMessageInputTokens,
          }),
      }));
      const rows = await tx.insert(messages).values(values).returning({ id: messages.id });
      const last = R.last(rows);
      if (!last) throw new Error("insertMessages: no rows returned");
      return last;
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

  async getHistory(conversationId: string): Promise<ReadonlyArray<Message>> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.id));
      return rows as ReadonlyArray<Message>;
    });
  }

  async getProfile(
    profileId: string,
  ): Promise<{ id: string; basePrompt: string; model: string; toolSet: JsonValue } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: profiles.id,
          basePrompt: profiles.basePrompt,
          model: profiles.model,
          toolSet: profiles.toolSet,
        })
        .from(profiles)
        .where(eq(profiles.id, profileId))
        .limit(1);
      return (
        (rows[0] as { id: string; basePrompt: string; model: string; toolSet: JsonValue }) ?? null
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
  ): Promise<{ id: string; role: string; content: string | ContentBlock[] } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: messages.id, role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1);
      return (rows[0] as { id: string; role: string; content: string | ContentBlock[] }) ?? null;
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

  // --- Evolution: correction extraction ---

  async getCorrections(profileId: string): Promise<
    ReadonlyArray<{
      id: string;
      rule: string;
      category: string;
      active: boolean;
      observationCount: number;
    }>
  > {
    return this.#db.transaction(async (tx) => {
      return tx
        .select({
          id: steeringRules.id,
          rule: steeringRules.rule,
          category: steeringRules.category,
          active: steeringRules.active,
          observationCount: steeringRules.observationCount,
        })
        .from(steeringRules)
        .where(
          and(
            eq(steeringRules.source, "correction"),
            or(isNull(steeringRules.profileId), eq(steeringRules.profileId, profileId)),
          ),
        )
        .orderBy(asc(steeringRules.priority));
    });
  }

  async upsertCorrection(params: {
    rule: string;
    category: string;
    profileId: string | null;
    existingRuleId?: string;
  }): Promise<{ id: string; promoted: boolean }> {
    return this.#db.transaction(async (tx) => {
      if (params.existingRuleId) {
        // Increment observation count; promote to active when reaching 2
        const rows = await tx
          .update(steeringRules)
          .set({
            observationCount: sql`${steeringRules.observationCount} + 1`,
            active: sql`CASE WHEN ${steeringRules.observationCount} + 1 >= 2 THEN true ELSE ${steeringRules.active} END`,
          })
          .where(eq(steeringRules.id, params.existingRuleId))
          .returning({
            id: steeringRules.id,
            active: steeringRules.active,
            observationCount: steeringRules.observationCount,
          });
        const row = rows[0];
        if (!row) throw new Error(`upsertCorrection: rule not found: ${params.existingRuleId}`);
        // promoted = just crossed the threshold (count is now 2 and active is true)
        return { id: row.id, promoted: row.observationCount === 2 && row.active };
      }

      // New correction — inactive until observed again
      const row = single(
        await tx
          .insert(steeringRules)
          .values({
            rule: params.rule,
            category: params.category,
            source: "correction",
            active: false,
            priority: 100,
            observationCount: 1,
            profileId: params.profileId,
          })
          .returning({ id: steeringRules.id }),
      );
      return { id: row.id, promoted: false };
    });
  }

  async countActiveRules(profileId: string): Promise<number> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ value: count() })
        .from(steeringRules)
        .where(
          and(
            eq(steeringRules.active, true),
            or(isNull(steeringRules.profileId), eq(steeringRules.profileId, profileId)),
          ),
        );
      return rows[0]?.value ?? 0;
    });
  }

  async replaceRules(params: {
    oldIds: string[];
    newRule: {
      rule: string;
      category: string;
      profileId: string | null;
      priority: number;
      observationCount: number;
    };
  }): Promise<{ id: string }> {
    return this.#db.transaction(async (tx) => {
      await tx.delete(steeringRules).where(inArray(steeringRules.id, params.oldIds));
      return single(
        await tx
          .insert(steeringRules)
          .values({
            rule: params.newRule.rule,
            category: params.newRule.category,
            source: "evolution",
            active: true,
            priority: params.newRule.priority,
            observationCount: params.newRule.observationCount,
            profileId: params.newRule.profileId,
          })
          .returning({ id: steeringRules.id }),
      );
    });
  }
}
