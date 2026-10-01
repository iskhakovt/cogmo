import { and, count, desc, eq, sql } from "drizzle-orm";
import { ok, type Result } from "neverthrow";
import * as R from "remeda";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { previewInboundText } from "../../transport/content.js";
import { truncate } from "../../util/string.js";
import { type AliasTaken, inSavepoint, uniqueViolationAs } from "./errors.js";
import type { VoiceMode } from "./profiles.js";
import { aliases, type CooldownState, conversations, messages, profiles } from "./schema.js";

export interface ConversationSummary {
  id: string;
  profileName: string;
  alias: string | null;
  lastMessagePreview: string;
  lastMessageAt: Date;
}

/**
 * The `conversations` row and its `aliases` row: who a conversation belongs
 * to, the profile it runs, its cooldown and voice override, and the name the
 * user calls it by. The messages it holds are `TranscriptStore`'s.
 */
export interface ConversationStore {
  /** Create a new conversation. */
  createConversation(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      isPrivate: boolean;
    },
  ): Promise<{ id: string }>;

  /** Load a conversation by ID. */
  getConversation(
    tx: Transaction,
    conversationId: string,
  ): Promise<
    | {
        id: string;
        userId: string;
        profileId: string;
        isPrivate: boolean;
        /** Auto-repair cooldown blob; null = CLOSED (normal operation). */
        cooldownState: CooldownState | null;
        /** Per-conversation voice mode override; null = follow profile default. */
        voiceMode: VoiceMode | null;
      }
    | undefined
  >;

  /**
   * Write the auto-repair cooldown blob. Called by `recover-conversation`
   * after `handle-message` exhausts retries — the caller computes the
   * next blob from the prior one via `nextCooldownState` and passes it
   * here. The store is unaware of the curve; it just persists the row.
   */
  writeCooldownState(tx: Transaction, conversationId: string, state: CooldownState): Promise<void>;

  /**
   * Clear the auto-repair cooldown blob to `NULL`. Called on the first
   * successful turn past the cooldown threshold (half-open success), by
   * `/repair`, and by `/model` / `/profile` switches. Idempotent — clearing
   * an already-clear row is a no-op write.
   */
  clearCooldown(tx: Transaction, conversationId: string): Promise<void>;

  /**
   * Set or clear the per-conversation voice mode override. `null` clears
   * the override (the conversation falls back to the profile default).
   * Used by `Transport.conversations.setVoiceMode` (`/voice` command).
   */
  setConversationVoiceMode(
    tx: Transaction,
    conversationId: string,
    mode: VoiceMode | null,
  ): Promise<void>;

  /**
   * Most recent private conversation for `(userId, profileId)` and the
   * timestamp of its last message (`null` when the conversation has no
   * messages yet, `undefined` when no such conversation exists).
   */
  findMostRecentConversationForUserProfile(
    tx: Transaction,
    userId: string,
    profileId: string,
  ): Promise<{ id: string; lastMessageAt: Date | null } | undefined>;

  // --- Conversation admin (Transport-facing) ---

  /** List private conversations owned by a user with last-message preview + alias + profile name. */
  listConversationsForUser(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<ConversationSummary>>;

  /** Update a conversation's active profile. Takes effect on the next turn (current in-flight turn keeps its snapshot). */
  setConversationProfile(tx: Transaction, conversationId: string, profileId: string): Promise<void>;

  /** Upsert or clear a conversation's alias. `alias: null` removes the alias row. */
  setAlias(
    tx: Transaction,
    userId: string,
    conversationId: string,
    alias: string | null,
  ): Promise<Result<void, AliasTaken>>;

  /** Resolve an alias to a conversation ID for a user. Returns `undefined` if no match. */
  findConversationByAlias(
    tx: Transaction,
    userId: string,
    alias: string,
  ): Promise<{ conversationId: string } | undefined>;

  /**
   * Resolve a conversation's alias scoped to `userId` — the SQL filter
   * matches on `(userId, conversationId)`, so a conversation owned by a
   * different user returns `null` (no separate ownership check at the
   * call site needed). Also returns `null` when the conversation has no
   * alias set.
   */
  getAliasForConversation(
    tx: Transaction,
    userId: string,
    conversationId: string,
  ): Promise<string | undefined>;

  /**
   * Conversation lifecycle stats — `createdAt`, total `messageCount`, and the
   * timestamp of the most recent message (`lastMessageAt`, `null` when no
   * messages yet). Returned in one transaction. Used by `/status` to surface
   * conversation age and activity without forcing the caller to make three
   * separate round-trips.
   */
  getConversationStats(
    tx: Transaction,
    conversationId: string,
  ): Promise<{ createdAt: Date; messageCount: number; lastMessageAt: Date | null } | undefined>;
}

const PREVIEW_MAX_CHARS = 120;

function isTextBlock(b: unknown): b is { type: "text"; text: string } {
  return (
    typeof b === "object" &&
    b !== null &&
    "type" in b &&
    b.type === "text" &&
    "text" in b &&
    typeof b.text === "string"
  );
}

/** Extract a short preview string from a `messages.content` jsonb value. */
function previewFromContent(content: unknown): string {
  if (typeof content === "string") return truncate(previewInboundText(content), PREVIEW_MAX_CHARS);
  if (!Array.isArray(content)) return "";
  const block = R.find(content, isTextBlock);
  return block ? truncate(previewInboundText(block.text), PREVIEW_MAX_CHARS) : "";
}

export class DrizzleConversationStore implements ConversationStore {
  async createConversation(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      isPrivate: boolean;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx.insert(conversations).values(params).returning({ id: conversations.id }),
    );
  }

  async getConversation(
    tx: Transaction,
    conversationId: string,
  ): Promise<
    | {
        id: string;
        userId: string;
        profileId: string;
        isPrivate: boolean;
        cooldownState: CooldownState | null;
        voiceMode: VoiceMode | null;
      }
    | undefined
  > {
    const rows = await tx
      .select({
        id: conversations.id,
        userId: conversations.userId,
        profileId: conversations.profileId,
        isPrivate: conversations.isPrivate,
        cooldownState: conversations.cooldownState,
        voiceMode: conversations.voiceMode,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    return rows[0];
  }

  async writeCooldownState(
    tx: Transaction,
    conversationId: string,
    state: CooldownState,
  ): Promise<void> {
    await tx
      .update(conversations)
      .set({ cooldownState: state })
      .where(eq(conversations.id, conversationId));
  }

  async clearCooldown(tx: Transaction, conversationId: string): Promise<void> {
    await tx
      .update(conversations)
      .set({ cooldownState: null })
      .where(eq(conversations.id, conversationId));
  }

  async setConversationVoiceMode(
    tx: Transaction,
    conversationId: string,
    mode: VoiceMode | null,
  ): Promise<void> {
    await tx
      .update(conversations)
      .set({ voiceMode: mode })
      .where(eq(conversations.id, conversationId));
  }

  async findMostRecentConversationForUserProfile(
    tx: Transaction,
    userId: string,
    profileId: string,
  ): Promise<{ id: string; lastMessageAt: Date | null } | undefined> {
    // Two queries instead of a correlated subquery: under PGlite,
    // Drizzle wraps the FROM in a sub-select for the trailing LIMIT and
    // the inner reference to `conversations.id` loses correlation.
    const convRows = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, userId),
          eq(conversations.profileId, profileId),
          eq(conversations.isPrivate, true),
        ),
      )
      .orderBy(desc(conversations.id))
      .limit(1);
    const conv = convRows[0];
    if (!conv) return undefined;

    const msgRows = await tx
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.id))
      .limit(1);
    return { id: conv.id, lastMessageAt: msgRows[0]?.createdAt ?? null };
  }

  // --- Conversation admin ---

  async listConversationsForUser(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<ConversationSummary>> {
    // One round-trip: pull every private conversation for the user with its profile name and
    // (optional) alias. Last-message preview is a correlated subquery — we want the latest row
    // regardless of role so /sessions shows the most recent activity.
    const rows = await tx
      .select({
        id: conversations.id,
        profileName: profiles.name,
        alias: aliases.alias,
        content: sql<unknown>`(
          SELECT ${messages.content}
          FROM ${messages}
          WHERE ${messages.conversationId} = ${conversations.id}
          ORDER BY ${messages.id} DESC
          LIMIT 1
        )`,
        lastMessageAt: sql<string | Date | null>`(
          SELECT ${messages.createdAt}
          FROM ${messages}
          WHERE ${messages.conversationId} = ${conversations.id}
          ORDER BY ${messages.id} DESC
          LIMIT 1
        )`,
      })
      .from(conversations)
      .innerJoin(profiles, eq(profiles.id, conversations.profileId))
      .leftJoin(aliases, eq(aliases.conversationId, conversations.id))
      .where(and(eq(conversations.userId, userId), eq(conversations.isPrivate, true)))
      .orderBy(desc(conversations.id));

    return rows
      .filter((r) => r.lastMessageAt != null) // skip conversations with no messages yet
      .map((r) => {
        // Correlated subquery loses the Drizzle column type mapper — driver returns either
        // a Date (postgres-js) or an ISO string (PGlite); normalize.
        const raw = r.lastMessageAt as Date | string;
        const lastMessageAt = raw instanceof Date ? raw : new Date(raw);
        return {
          id: r.id,
          profileName: r.profileName,
          alias: r.alias,
          lastMessagePreview: previewFromContent(r.content),
          lastMessageAt,
        };
      });
  }

  async setConversationProfile(
    tx: Transaction,
    conversationId: string,
    profileId: string,
  ): Promise<void> {
    await tx.update(conversations).set({ profileId }).where(eq(conversations.id, conversationId));
  }

  async setAlias(
    tx: Transaction,
    userId: string,
    conversationId: string,
    alias: string | null,
  ): Promise<Result<void, AliasTaken>> {
    if (alias === null) {
      await tx.delete(aliases).where(eq(aliases.conversationId, conversationId));
      return ok(undefined);
    }
    return inSavepoint(tx, (sp) =>
      uniqueViolationAs("uq_aliases_user_alias", { kind: "alias_taken" } as const, async () => {
        await sp.insert(aliases).values({ userId, conversationId, alias }).onConflictDoUpdate({
          target: aliases.conversationId,
          set: { alias },
        });
      }),
    );
  }

  async findConversationByAlias(
    tx: Transaction,
    userId: string,
    alias: string,
  ): Promise<{ conversationId: string } | undefined> {
    const rows = await tx
      .select({ conversationId: aliases.conversationId })
      .from(aliases)
      .where(and(eq(aliases.userId, userId), eq(aliases.alias, alias)))
      .limit(1);
    return rows[0];
  }

  async getAliasForConversation(
    tx: Transaction,
    userId: string,
    conversationId: string,
  ): Promise<string | undefined> {
    const rows = await tx
      .select({ alias: aliases.alias })
      .from(aliases)
      .where(and(eq(aliases.userId, userId), eq(aliases.conversationId, conversationId)))
      .limit(1);
    return rows[0]?.alias;
  }

  async getConversationStats(
    tx: Transaction,
    conversationId: string,
  ): Promise<{ createdAt: Date; messageCount: number; lastMessageAt: Date | null } | undefined> {
    const convRows = await tx
      .select({ createdAt: conversations.createdAt })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const conv = convRows[0];
    if (!conv) return undefined;
    const [countRows, lastRows] = await Promise.all([
      tx
        .select({ value: count() })
        .from(messages)
        .where(eq(messages.conversationId, conversationId)),
      tx
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.id))
        .limit(1),
    ]);
    return {
      createdAt: conv.createdAt,
      messageCount: countRows[0]?.value ?? 0,
      lastMessageAt: lastRows[0]?.createdAt ?? null,
    };
  }
}
