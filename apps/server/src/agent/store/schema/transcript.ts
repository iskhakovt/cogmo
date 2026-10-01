import { index, integer, pgEnum, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import { MessageContentSchema } from "../../../llm/types.js";
import { TurnContextSchema } from "../../turn-context.js";
import { conversations } from "./conversations.js";
import { profiles } from "./profiles.js";

/**
 * `conversation_summaries.source` — which path produced the row. `turn` is the
 * 80%-budget summarize strategy firing inside `handle-message`; `manual` is an
 * explicit `/compact`. Both write the same shape. Nothing reads the column:
 * it, and `messages_summarized` beside it, are an audit trail for reasoning
 * about a conversation's compaction history from the table itself.
 */
export const summarySource = pgEnum("summary_source", ["turn", "manual"]);
export type SummarySourceValue = (typeof summarySource.enumValues)[number];

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: jsonbZod("content", MessageContentSchema).notNull(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id), // profile active for the turn this row belongs to
    model: text("model").notNull(), // model active for the turn; legacy backfill = '<legacy>' sentinel
    lastInboundMessageId: uuid("last_inbound_message_id").notNull(),
    inputTokens: integer("input_tokens"), // nullable — only set on assistant messages
    // NOT NULL, no default — callers must pass explicitly for assistant rows
    // (via `lastMessageOutputTokens`). Backfilled to -1 for pre-migration rows
    // and used as a sentinel on non-assistant rows where output is N/A; the
    // fast path (`shouldSkipCounting`) treats -1 as "unknown → force count".
    outputTokens: integer("output_tokens").notNull(),
    createdAt: ts(),
  },
  (t) => [
    index("idx_messages_conv_id").on(t.conversationId, t.id),
    index("idx_messages_profile_id").on(t.profileId),
  ],
);

/**
 * Durable conversation summaries — the persisted output of the summarize
 * compaction strategy.
 *
 * The rest of compaction stores nothing: Strategy 1 is an edit intent on the
 * request, and Strategy 3 drops messages from the turn's view in memory.
 * Summarization is different: it costs an LLM call, so its result is written
 * here and replayed on every subsequent turn instead of being recomputed.
 * `through_message_id` names the last message the summary stands in for — the
 * turn loader drops every message up to and including it and prepends the
 * summary as a single user message. See design/context-management.md →
 * Durable summaries.
 *
 * The two foreign keys are independent, so the schema alone permits a row
 * pairing conversation A with a message from conversation B — a cutoff that
 * would make `getHistoryAfter` drop an arbitrary span of A. No writer can
 * produce one: both derive the cutoff from `summarizedSpan` over the message
 * ids of the conversation being compacted. Enforcing it in DDL would mean a
 * composite unique on `messages (id, conversation_id)` purely to serve a
 * composite FK, which is an index on the hottest table in the schema to
 * prevent a state no code path reaches. The invariant lives at the two call
 * sites instead.
 *
 * Append-only. Re-compaction inserts a new row summarizing the previous
 * summary plus everything that arrived since; the loader reads the row with the
 * greatest `through_message_id` — widest coverage wins, not last-inserted. The
 * two orders agree in normal operation (each compaction covers strictly more
 * than the last) and diverge only when a slow `/compact` commits a narrower
 * summary after a turn already stored a wider one. The unique on (conversation_id, through_message_id) is the
 * idempotency key for the write step — an Inngest retry that re-runs a
 * committed insert lands on the existing row rather than duplicating it.
 */
export const conversationSummaries = pgTable(
  "conversation_summaries",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    summary: text("summary").notNull(),
    /** Last message covered by this summary. Snapped to a tool_use/tool_result pair boundary at write time. */
    throughMessageId: uuid("through_message_id")
      .notNull()
      .references(() => messages.id),
    /** Real messages this summary replaced — audit trail, not a cursor. Excludes a previous summary folded in. */
    messagesSummarized: integer("messages_summarized").notNull(),
    /** Summarization model that produced the text. */
    model: text("model").notNull(),
    /** `manual` = `/compact`; `turn` = the 80% budget strategy firing mid-turn. */
    source: summarySource("source").notNull(),
    createdAt: ts(),
  },
  // The unique doubles as the read path: `(conversation_id, through_message_id)`
  // scanned backwards serves "widest summary for this conversation", which is
  // how the latest-summary lookup is ordered. No second index needed.
  (t) => [
    unique("uq_conversation_summaries_conv_through").on(t.conversationId, t.throughMessageId),
  ],
);

/**
 * The turn context a turn-starting user row was sent with: the exact block and
 * its inputs. Immutable; unique on `message_id`, the render step's idempotency
 * key. See design/prompt-caching.md → Turn Context → Data model.
 */
export const turnContexts = pgTable(
  "turn_contexts",
  {
    id: pk(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id),
    rendered: text("rendered").notNull(),
    context: jsonbZod("context", TurnContextSchema).notNull(),
    createdAt: ts(),
  },
  (t) => [unique("uq_turn_contexts_message").on(t.messageId)],
);

/**
 * The system prompt a conversation's chat turns send for one epoch: rendered
 * when the epoch opens, sent unchanged until the next. Immutable; unique on
 * `opened_by`, the opening step's idempotency key. See
 * design/prompt-caching.md → System Prompt Snapshot.
 */
export const systemPromptSnapshots = pgTable(
  "system_prompt_snapshots",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /** The turn-starting user row that opened the epoch. */
    openedBy: uuid("opened_by")
      .notNull()
      .references(() => messages.id),
    /** The first message the epoch's history holds after the conversation's latest summary. */
    historyStart: uuid("history_start")
      .notNull()
      .references(() => messages.id),
    rendered: text("rendered").notNull(),
    /** Digest of everything `rendered` holds but core memory. */
    configDigest: text("config_digest").notNull(),
    createdAt: ts(),
  },
  // `opened_by` alone identifies an epoch, since a message belongs to one
  // conversation; pairing it with the conversation makes the unique double as
  // the read path: scanned backwards, it serves "the epoch opened latest in the
  // transcript". No second index needed.
  (t) => [unique("uq_system_prompt_snapshots_conv_opened_by").on(t.conversationId, t.openedBy)],
);
