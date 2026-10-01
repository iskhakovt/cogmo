import { and, asc, desc, eq, getTableColumns, gt, isNull, ne, not, or, sql } from "drizzle-orm";
import * as R from "remeda";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { NOT_TURN_ROW_JSONPATH } from "../../llm/content.js";
import type { ContentBlock, Message } from "../../llm/types.js";
import { inboundMessages } from "../../transport/store/schema.js";
import type { TurnContext } from "../turn-context.js";
import {
  conversationSummaries,
  messages,
  type SummarySourceValue,
  systemPromptSnapshots,
  turnContexts,
} from "./schema.js";

/**
 * Sentinel for `messages.output_tokens` meaning "unknown — force a full token
 * count on next turn." Used on:
 *   1. Rows migrated from before the column existed (backfill in 0008).
 *   2. Rows that never had a meaningful output count (user rows, intermediate
 *      tool turns) — harmless because the fast path only reads the most
 *      recent **assistant** row, which always carries the real count.
 */
const UNKNOWN_OUTPUT_TOKENS = -1;

/**
 * A row from `conversation_summaries` — the persisted output of the summarize
 * compaction strategy. Distinct from `ConversationSummary`, which is the
 * `/sessions` listing row.
 */
export interface CompactionSummary {
  id: string;
  conversationId: string;
  summary: string;
  throughMessageId: string;
  messagesSummarized: number;
  model: string;
  source: SummarySourceValue;
  createdAt: Date;
}

/** A row from `turn_contexts`: the block a turn-starting user message was sent with. */
export interface StoredTurnContext {
  messageId: string;
  rendered: string;
  context: TurnContext;
}

/** A row from `system_prompt_snapshots`: one epoch's system prompt. */
export interface SystemPromptSnapshot {
  id: string;
  conversationId: string;
  openedBy: string;
  historyStart: string;
  rendered: string;
  configDigest: string;
  createdAt: Date;
}

/**
 * One past turn for the web chat history read — `text` is the message's
 * displayable prose. Mirrored in `@cogmo/contracts`; see that definition for
 * why tool-call cards aren't reconstructed here.
 */
export interface ChatHistoryMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/**
 * A conversation's append-only record of its turns: the `messages` rows and
 * what was derived from them and must replay byte-stable — compaction
 * summaries, turn contexts and system prompt snapshots.
 */
export interface TranscriptStore {
  /** Insert a message (user or assistant). Returns the new message ID. `profileId` + `model` stamp the turn snapshot (see design/transport/overview.md → Profile and Model Stamping). */
  insertMessage(
    tx: Transaction,
    params: {
      conversationId: string;
      role: "user" | "assistant";
      content: string | ContentBlock[];
      profileId: string;
      model: string;
      lastInboundMessageId: string;
      inputTokens?: number;
    },
  ): Promise<{ id: string }>;

  /**
   * The turn-starting user row whose cursor is `inboundId`: the newest user
   * row holding no `tool_result` block and no harness-tagged block. A turn's
   * tool results and its continuation prompt are later user rows on the same
   * cursor. Newest, because an insert re-run after its commit leaves two turn
   * rows on one cursor, and the turn that looks is the one that wrote the
   * last.
   */
  findUserMessageByInbound(
    tx: Transaction,
    conversationId: string,
    inboundId: string,
  ): Promise<{ id: string; createdAt: Date } | undefined>;

  /**
   * Insert multiple messages atomically in a single transaction. Returns the
   * last inserted ID. All rows share the same `profileId` + `model` snapshot.
   *
   * `lastMessageInputTokens` / `lastMessageOutputTokens` land on the **final**
   * row (the assistant's visible reply). Output is required — the fast-path
   * budget estimator (`shouldSkipCounting`) needs both, because the
   * assistant's reply is part of next turn's input. Non-final rows (tool
   * turns) get `output_tokens = -1` (sentinel: "unknown, force count").
   */
  insertMessages(
    tx: Transaction,
    params: {
      conversationId: string;
      messages: ReadonlyArray<Message>;
      profileId: string;
      model: string;
      lastInboundMessageId: string;
      lastMessageInputTokens?: number;
      lastMessageOutputTokens: number;
    },
  ): Promise<{ id: string }>;

  /**
   * The newest assistant message answering chat input — its cursor is the
   * inbound batch the chat pipeline has consumed. Assistant messages a
   * pipeline stage wrote cursor on a `source='pipeline'` inbound and are
   * skipped: counting them would mark chat messages sent before the stage's
   * prompt as already answered.
   */
  getLastAssistantMessage(
    tx: Transaction,
    conversationId: string,
  ): Promise<{ id: string; lastInboundMessageId: string } | undefined>;

  /**
   * A conversation's complete message history with row ids, ordered by id.
   *
   * The raw transcript, not the compacted turn view — `loadTurnHistory` layers
   * durable summaries on top of this for the LLM-facing path, while the
   * Observer and the web history read take it as-is.
   */
  listMessages(
    tx: Transaction,
    conversationId: string,
  ): Promise<ReadonlyArray<Message & { id: string }>>;

  /**
   * Widest durable summary for a conversation, or undefined when it has never
   * been compacted. The turn loader replaces every message up to and including
   * `throughMessageId` with this text; the Observer deliberately does not read
   * it, so fact extraction still sees the complete transcript.
   */
  getLatestSummary(tx: Transaction, conversationId: string): Promise<CompactionSummary | undefined>;

  /**
   * Store a turn's context, or return the one already stored for this message.
   * The message id is the idempotency key of the render step: a retry that
   * re-runs a committed insert gets the first attempt's text back, so the turn
   * sends the bytes later turns will load.
   */
  insertOrRecoverTurnContext(
    tx: Transaction,
    params: StoredTurnContext,
  ): Promise<StoredTurnContext>;

  /**
   * The stored turn contexts of a conversation's messages newer than
   * `afterMessageId` (every message when `null`), in no particular order: the
   * contexts of the rows `getHistoryAfter` / `listMessages` return.
   */
  listTurnContexts(
    tx: Transaction,
    conversationId: string,
    afterMessageId: string | null,
  ): Promise<ReadonlyArray<StoredTurnContext>>;

  /** The conversation's current epoch: the snapshot opened latest in the transcript. */
  getLatestSystemPromptSnapshot(
    tx: Transaction,
    conversationId: string,
  ): Promise<SystemPromptSnapshot | undefined>;

  /**
   * Store the snapshot a turn opens, or return the one already stored for that
   * turn. `(conversationId, openedBy)` is the opening step's idempotency key: a
   * retry that re-runs a committed insert gets the first attempt's row back.
   */
  insertOrRecoverSystemPromptSnapshot(
    tx: Transaction,
    params: Omit<SystemPromptSnapshot, "id" | "createdAt">,
  ): Promise<SystemPromptSnapshot>;

  /**
   * Append a summary, or recover the existing row when this
   * (conversationId, throughMessageId) pair was already written.
   *
   * The pair is the idempotency key for the Inngest step that writes it: a
   * retry that re-runs a committed insert lands on the conflict arm rather
   * than appending a second row for the same span. `kind` reports which arm
   * ran, so a caller can tell a fresh compaction from a replayed one.
   */
  insertOrRecoverSummary(
    tx: Transaction,
    params: {
      conversationId: string;
      summary: string;
      throughMessageId: string;
      messagesSummarized: number;
      model: string;
      source: SummarySourceValue;
    },
  ): Promise<{ kind: "new" | "recovered"; row: CompactionSummary }>;

  /**
   * Messages of a conversation newer than `afterMessageId`, ordered by id.
   * Backs the compacted turn view — the summary stands in for everything at or
   * before the cutoff. UUIDv7 ids are time-ordered, so the `>` comparison is
   * an ordering predicate, not just an identity one.
   */
  getHistoryAfter(
    tx: Transaction,
    conversationId: string,
    afterMessageId: string,
  ): Promise<ReadonlyArray<Message & { id: string }>>;

  /** Load a single message by ID. */
  getMessage(
    tx: Transaction,
    messageId: string,
  ): Promise<{ id: string; role: string; content: string | ContentBlock[] } | undefined>;

  /** Get the timestamp of the most recent message in a conversation (any role). `undefined` when no messages. */
  getLastMessageTime(tx: Transaction, conversationId: string): Promise<Date | undefined>;

  /**
   * Get `{ inputTokens, outputTokens }` from the most recent assistant
   * message, for the fast-path budget estimator. Returns `undefined` if no
   * assistant row exists. The inner `inputTokens` may be `null` (column was
   * never written for legacy rows) or the actual integer; `-1` is the
   * pre-migration sentinel for `outputTokens`. The fast path treats both
   * as "unknown → force count".
   */
  getLastTokens(
    tx: Transaction,
    conversationId: string,
  ): Promise<
    | {
        inputTokens: number | null;
        outputTokens: number;
      }
    | undefined
  >;
}

export class DrizzleTranscriptStore implements TranscriptStore {
  async insertMessage(
    tx: Transaction,
    params: {
      conversationId: string;
      role: "user" | "assistant";
      content: string | ContentBlock[];
      profileId: string;
      model: string;
      lastInboundMessageId: string;
      inputTokens?: number;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(messages)
        .values({
          conversationId: params.conversationId,
          role: params.role,
          content: params.content,
          profileId: params.profileId,
          model: params.model,
          lastInboundMessageId: params.lastInboundMessageId,
          ...(params.inputTokens != null && { inputTokens: params.inputTokens }),
          // Singular insert is only used for user rows (and the orchestrator's
          // initial synthesized user message) — they never have an output
          // count. Sentinel -1 tells the fast path "unknown, force count" if
          // this row were ever the most-recent assistant (it isn't).
          outputTokens: UNKNOWN_OUTPUT_TOKENS,
        })
        .returning({ id: messages.id }),
    );
  }

  async findUserMessageByInbound(
    tx: Transaction,
    conversationId: string,
    inboundId: string,
  ): Promise<{ id: string; createdAt: Date } | undefined> {
    // Drizzle has no operator for a JSON path, so the predicate is raw; the
    // path is `isTurnRowContent`'s rule, bound as a parameter.
    const rows = await tx
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.lastInboundMessageId, inboundId),
          eq(messages.role, "user"),
          not(sql`jsonb_path_exists(${messages.content}, ${NOT_TURN_ROW_JSONPATH}::jsonpath)`),
        ),
      )
      .orderBy(desc(messages.id))
      .limit(1);
    return rows[0];
  }

  async insertMessages(
    tx: Transaction,
    params: {
      conversationId: string;
      messages: ReadonlyArray<Message>; // must be non-empty
      profileId: string;
      model: string;
      lastInboundMessageId: string;
      lastMessageInputTokens?: number;
      lastMessageOutputTokens: number;
    },
  ): Promise<{ id: string }> {
    if (params.messages.length === 0) {
      throw new Error("insertMessages requires at least one message");
    }
    const lastIdx = params.messages.length - 1;
    const values = R.map(params.messages, (msg, i) => ({
      conversationId: params.conversationId,
      role: msg.role,
      content: msg.content,
      profileId: params.profileId,
      model: params.model,
      lastInboundMessageId: params.lastInboundMessageId,
      ...(i === lastIdx &&
        params.lastMessageInputTokens != null && {
          inputTokens: params.lastMessageInputTokens,
        }),
      // Intermediate tool turns get the sentinel — only the final assistant
      // row carries the real aggregated outputTokens for the fast path.
      outputTokens: i === lastIdx ? params.lastMessageOutputTokens : UNKNOWN_OUTPUT_TOKENS,
    }));
    const rows = await tx.insert(messages).values(values).returning({ id: messages.id });
    const last = R.last(rows);
    if (!last) throw new Error("insertMessages: no rows returned");
    return last;
  }

  async getLastAssistantMessage(
    tx: Transaction,
    conversationId: string,
  ): Promise<{ id: string; lastInboundMessageId: string } | undefined> {
    const rows = await tx
      .select({
        id: messages.id,
        lastInboundMessageId: messages.lastInboundMessageId,
      })
      .from(messages)
      // Left join: the cursor is not a foreign key, and a row whose cursor has
      // no inbound (fixtures, pruned buffers) is still a chat turn.
      .leftJoin(inboundMessages, eq(inboundMessages.id, messages.lastInboundMessageId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.role, "assistant"),
          or(isNull(inboundMessages.source), ne(inboundMessages.source, "pipeline")),
        ),
      )
      .orderBy(desc(messages.id))
      .limit(1);
    return rows[0];
  }

  async listMessages(
    tx: Transaction,
    conversationId: string,
  ): Promise<ReadonlyArray<Message & { id: string }>> {
    const rows = await tx
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.id));
    return rows as ReadonlyArray<Message & { id: string }>;
  }

  async getLatestSummary(
    tx: Transaction,
    conversationId: string,
  ): Promise<CompactionSummary | undefined> {
    const rows = await tx
      .select()
      .from(conversationSummaries)
      .where(eq(conversationSummaries.conversationId, conversationId))
      // Widest coverage, not last inserted — see the table's schema comment.
      .orderBy(desc(conversationSummaries.throughMessageId))
      .limit(1);
    return rows[0];
  }

  async insertOrRecoverSummary(
    tx: Transaction,
    params: {
      conversationId: string;
      summary: string;
      throughMessageId: string;
      messagesSummarized: number;
      model: string;
      source: SummarySourceValue;
    },
  ): Promise<{ kind: "new" | "recovered"; row: CompactionSummary }> {
    // Keyed insert: see `.claude/rules/inngest.md`.
    const rows = await tx
      .insert(conversationSummaries)
      .values(params)
      .onConflictDoUpdate({
        target: [conversationSummaries.conversationId, conversationSummaries.throughMessageId],
        set: { throughMessageId: params.throughMessageId },
      })
      .returning({
        ...getTableColumns(conversationSummaries),
        inserted: sql<boolean>`(xmax = 0)`,
      });
    const { inserted, ...row } = single(rows);
    return { kind: inserted ? "new" : "recovered", row };
  }

  async insertOrRecoverTurnContext(
    tx: Transaction,
    params: StoredTurnContext,
  ): Promise<StoredTurnContext> {
    // Keyed insert: see `.claude/rules/inngest.md`.
    return single(
      await tx
        .insert(turnContexts)
        .values(params)
        .onConflictDoUpdate({
          target: turnContexts.messageId,
          set: { messageId: params.messageId },
        })
        .returning({
          messageId: turnContexts.messageId,
          rendered: turnContexts.rendered,
          context: turnContexts.context,
        }),
    );
  }

  async listTurnContexts(
    tx: Transaction,
    conversationId: string,
    afterMessageId: string | null,
  ): Promise<ReadonlyArray<StoredTurnContext>> {
    return tx
      .select({
        messageId: turnContexts.messageId,
        rendered: turnContexts.rendered,
        context: turnContexts.context,
      })
      .from(turnContexts)
      .innerJoin(messages, eq(messages.id, turnContexts.messageId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          afterMessageId === null ? undefined : gt(messages.id, afterMessageId),
        ),
      );
  }

  async getLatestSystemPromptSnapshot(
    tx: Transaction,
    conversationId: string,
  ): Promise<SystemPromptSnapshot | undefined> {
    const rows = await tx
      .select()
      .from(systemPromptSnapshots)
      .where(eq(systemPromptSnapshots.conversationId, conversationId))
      .orderBy(desc(systemPromptSnapshots.openedBy))
      .limit(1);
    return rows[0];
  }

  async insertOrRecoverSystemPromptSnapshot(
    tx: Transaction,
    params: Omit<SystemPromptSnapshot, "id" | "createdAt">,
  ): Promise<SystemPromptSnapshot> {
    // Keyed insert: see `.claude/rules/inngest.md`.
    return single(
      await tx
        .insert(systemPromptSnapshots)
        .values(params)
        .onConflictDoUpdate({
          target: [systemPromptSnapshots.conversationId, systemPromptSnapshots.openedBy],
          set: { openedBy: params.openedBy },
        })
        .returning(),
    );
  }

  async getHistoryAfter(
    tx: Transaction,
    conversationId: string,
    afterMessageId: string,
  ): Promise<ReadonlyArray<Message & { id: string }>> {
    const rows = await tx
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), gt(messages.id, afterMessageId)))
      .orderBy(asc(messages.id));
    return rows as ReadonlyArray<Message & { id: string }>;
  }

  async getMessage(
    tx: Transaction,
    messageId: string,
  ): Promise<{ id: string; role: string; content: string | ContentBlock[] } | undefined> {
    const rows = await tx
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    return rows[0];
  }

  async getLastMessageTime(tx: Transaction, conversationId: string): Promise<Date | undefined> {
    const rows = await tx
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.id))
      .limit(1);
    return rows[0]?.createdAt;
  }

  async getLastTokens(
    tx: Transaction,
    conversationId: string,
  ): Promise<
    | {
        inputTokens: number | null;
        outputTokens: number;
      }
    | undefined
  > {
    const rows = await tx
      .select({
        inputTokens: messages.inputTokens,
        outputTokens: messages.outputTokens,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
      .orderBy(desc(messages.id))
      .limit(1);
    return rows[0];
  }
}
