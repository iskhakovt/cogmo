import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { HARNESS_ROW_TAGS, type Message } from "../../llm/types.js";
import { seedConversation } from "../../test/agent-store-fixtures.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { inboundMessages } from "../../transport/store/schema.js";
import { DrizzleConversationStore } from "./conversations.js";
import { conversationSummaries, messages, systemPromptSnapshots } from "./schema.js";
import { DrizzleTranscriptStore } from "./transcript.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleTranscriptStore();
const conversationStore = new DrizzleConversationStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("DrizzleTranscriptStore", () => {
  describe("messages", () => {
    it("inserts and retrieves messages in order", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "Hello",
          lastInboundMessageId: inboundId,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );
      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "assistant",
          content: "Hi there",
          lastInboundMessageId: inboundId,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );

      const history = await tx((trx) => store.listMessages(trx, conversationId));
      expect(history).toHaveLength(2);
      expect(history.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ]);
    });

    it("listMessages returns messages with ids in order", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      const first = await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "Hello",
          lastInboundMessageId: inboundId,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );
      await new Promise((r) => setTimeout(r, 2));
      const second = await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          lastInboundMessageId: inboundId,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );

      const list = await tx((trx) => store.listMessages(trx, conversationId));
      expect(list).toEqual([
        { id: first.id, role: "user", content: "Hello" },
        { id: second.id, role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ]);
    });

    it("keeps harness tags through a write and a reload, and rejects an unknown one", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";
      const written: Message[] = [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "img", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "t1",
              content: "stop",
              isError: true,
              harness: "volume_nudge",
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Please complete your response.", harness: "continuation" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Partial" },
            { type: "text", text: "\n\n[cut]", harness: "truncation_notice" },
          ],
        },
      ];
      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          lastInboundMessageId: inboundId,
          ...stamp,
          messages: written,
          lastMessageOutputTokens: 5,
        }),
      );

      const list = await tx((trx) => store.listMessages(trx, conversationId));
      expect(list.map(({ role, content }) => ({ role, content }))).toEqual(written);

      await expect(
        tx((trx) =>
          store.insertMessage(trx, {
            conversationId,
            role: "user",
            content: [{ type: "text", text: "x", harness: "made_up" }] as never,
            lastInboundMessageId: inboundId,
            firstInboundMessageId: null,
            ...stamp,
          }),
        ),
      ).rejects.toThrow();
    });

    it("getMessage returns a single message", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      const { id } = await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: [{ type: "text", text: "structured" }],
          lastInboundMessageId: inboundId,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );

      const msg = await tx((trx) => store.getMessage(trx, id));
      expect(msg).toEqual({ id, role: "user", content: [{ type: "text", text: "structured" }] });
    });

    it("returns null for unknown message", async () => {
      expect(
        await tx((trx) => store.getMessage(trx, "019d0000-0000-7000-8000-000000000000")),
      ).toBeUndefined();
    });

    it("insertMessages batch inserts with tool_use/tool_result pairing", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      const result = await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "test" } }],
            },
            {
              role: "user",
              content: [{ type: "tool_result", toolUseId: "t1", content: "search result" }],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "Here is the answer" }],
            },
          ],
          lastInboundMessageId: inboundId,
          lastMessageInputTokens: 500,
          lastMessageOutputTokens: 120,
          ...stamp,
        }),
      );

      expect(result.id).toBeDefined();
      expect(result.id).not.toBe("");

      const history = await tx((trx) => store.listMessages(trx, conversationId));
      expect(history).toHaveLength(3);
      // Asserts on content presence rather than position — the subject here is
      // what `insertMessages` wrote, not the order `listMessages` returns it in.
      const contents = history.map((m) => m.content);
      expect(contents).toContainEqual([
        { type: "tool_use", id: "t1", name: "search", input: { q: "test" } },
      ]);
      expect(contents).toContainEqual([
        { type: "tool_result", toolUseId: "t1", content: "search result" },
      ]);
      expect(contents).toContainEqual([{ type: "text", text: "Here is the answer" }]);
    });

    // A lone surrogate in `tool_use.input` survives Zod (`input` is
    // `z.unknown()`) and reaches JSON.stringify, which escapes it as `\udXXX`
    // — a form Postgres rejects with 22P02. The turn's tool side effects have
    // already run by then, so the rejection repeats identically on every
    // Inngest retry.
    it("insertMessages persists tool_use input carrying a lone surrogate", async () => {
      const { conversationId, stamp } = await seedConversation(tx);

      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "t1",
                  name: "search",
                  input: { q: "bad\uD800end", "k\uDC00": "v" },
                },
              ],
            },
            { role: "assistant", content: [{ type: "text", text: "done\uD800" }] },
          ],
          lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
          lastMessageOutputTokens: 10,
          ...stamp,
        }),
      );

      const history = await tx((trx) => store.listMessages(trx, conversationId));
      const contents = history.map((m) => m.content);
      expect(contents).toContainEqual([
        { type: "tool_use", id: "t1", name: "search", input: { q: "bad�end", "k�": "v" } },
      ]);
      expect(contents).toContainEqual([{ type: "text", text: "done�" }]);
    });

    // `jsonb` keeps object keys ordered by length, then bytewise, so a
    // tool_use input written in the model's emission order reloads in a
    // different one. The loop sends every later request with the input in
    // canonical key order; the reload has to reproduce those bytes, or the
    // prompt cache misses from this call on.
    it("listMessages returns tool_use input in canonical key order, not jsonb storage order", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      // Emission order. jsonb would store the top level as
      // {model, prompt, options, aspect_ratio} and `options` as
      // {seed, loras, guidance_scale}; canonical order sorts both.
      const input = {
        prompt: "a cat",
        model: "flux",
        options: { seed: 7, guidance_scale: 3, loras: [{ weight: 1, path: "x" }] },
        aspect_ratio: "1:1",
      };

      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "t1", name: "generate_image", input }],
            },
          ],
          lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
          lastMessageOutputTokens: 10,
          ...stamp,
        }),
      );

      const history = await tx((trx) => store.listMessages(trx, conversationId));
      const block = expectDefined(history[0]?.content[0]);
      // The block the loop appends: the same input with sorted keys at every depth.
      expect(JSON.stringify(block)).toBe(
        '{"type":"tool_use","id":"t1","name":"generate_image","input":{"aspect_ratio":"1:1","model":"flux","options":{"guidance_scale":3,"loras":[{"path":"x","weight":1}],"seed":7},"prompt":"a cat"}}',
      );
    });

    it("insertMessages throws on empty array", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      await expect(
        tx((trx) =>
          store.insertMessages(trx, {
            conversationId,
            messages: [],
            lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
            lastMessageOutputTokens: 0,
            ...stamp,
          }),
        ),
      ).rejects.toThrow("insertMessages requires at least one message");
    });

    it("insertMessages writes token counts onto the last message only", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [
            { role: "assistant", content: [{ type: "text", text: "first" }] },
            { role: "user", content: "follow-up" },
            { role: "assistant", content: [{ type: "text", text: "second" }] },
          ],
          lastInboundMessageId: inboundId,
          lastMessageInputTokens: 42,
          lastMessageOutputTokens: 7,
          ...stamp,
        }),
      );

      // Read the raw table: the token columns this asserts on aren't part of
      // what `listMessages` projects, so the store can't answer the question.
      const rows = await db
        .select({
          role: messages.role,
          inputTokens: messages.inputTokens,
          outputTokens: messages.outputTokens,
        })
        .from(messages)
        .where(eq(messages.conversationId, conversationId));

      // Only one row carries real token counts — the final assistant reply.
      const finalRow = rows.find((r) => r.inputTokens != null);
      expect(finalRow).toBeDefined();
      expect(finalRow!.inputTokens).toBe(42);
      expect(finalRow!.outputTokens).toBe(7);

      // Non-final rows: inputTokens null, outputTokens is the -1 sentinel.
      const otherRows = rows.filter((r) => r.inputTokens == null);
      expect(otherRows).toHaveLength(2);
      for (const r of otherRows) {
        expect(r.outputTokens).toBe(-1);
      }
    });

    it("getLastAssistantMessage returns most recent", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      expect(await tx((trx) => store.getLastAssistantMessage(trx, conversationId))).toBeUndefined();

      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "assistant",
          content: "first",
          lastInboundMessageId: inboundId,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );
      // UUIDv7 is time-ordered per millisecond — ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 2));
      const { id: secondId } = await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "assistant",
          content: "second",
          lastInboundMessageId: inboundId,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );

      const last = await tx((trx) => store.getLastAssistantMessage(trx, conversationId));
      expect(last?.id).toBe(secondId);
      expect(last?.lastInboundMessageId).toBe(inboundId);
    });

    it("getLastAssistantMessage skips messages a pipeline stage wrote", async () => {
      // A stage's assistant rows cursor on its `source='pipeline'` inbound.
      // Reading that as the chat cursor would mark earlier chat input answered.
      const { conversationId, stamp } = await seedConversation(tx);
      const [chatInbound] = await db
        .insert(inboundMessages)
        .values({
          source: "scheduled",
          idempotencyKey: "task-1:2026-09-12T09:00:00.000Z",
          conversationId,
          content: "briefing",
          platformTs: new Date(),
        })
        .returning({ id: inboundMessages.id });
      const chatCursor = expectDefined(chatInbound, "chat inbound").id;
      const { id: chatReplyId } = await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "assistant",
          content: "chat reply",
          lastInboundMessageId: chatCursor,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );
      await new Promise((r) => setTimeout(r, 2));
      const [stageInbound] = await db
        .insert(inboundMessages)
        .values({
          source: "pipeline",
          idempotencyKey: "pipeline:run-1:draft:0",
          conversationId,
          content: "stage prompt",
          platformTs: new Date(),
        })
        .returning({ id: inboundMessages.id });
      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "assistant",
          content: "stage output",
          lastInboundMessageId: expectDefined(stageInbound, "stage inbound").id,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );

      const last = await tx((trx) => store.getLastAssistantMessage(trx, conversationId));
      expect(last).toEqual({ id: chatReplyId, lastInboundMessageId: chatCursor });
    });

    it("listMessages returns empty array for no messages", async () => {
      const { conversationId } = await seedConversation(tx);
      expect(await tx((trx) => store.listMessages(trx, conversationId))).toEqual([]);
    });

    it("insertMessages persists both token counts and getLastTokens returns them", async () => {
      // After a turn with input=N, output=M, getLastTokens should report
      // both — the fast path needs both terms to estimate next-turn input.
      const { conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [{ role: "assistant", content: [{ type: "text", text: "response" }] }],
          lastInboundMessageId: inboundId,
          lastMessageInputTokens: 5432,
          lastMessageOutputTokens: 321,
          ...stamp,
        }),
      );

      expect(await tx((trx) => store.getLastTokens(trx, conversationId))).toEqual({
        inputTokens: 5432,
        outputTokens: 321,
      });
    });

    it("getLastTokens returns null when no assistant messages", async () => {
      const { conversationId } = await seedConversation(tx);
      expect(await tx((trx) => store.getLastTokens(trx, conversationId))).toBeUndefined();
    });

    it("getLastTokens returns the most recent assistant row's tokens", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [{ role: "assistant", content: [{ type: "text", text: "first" }] }],
          lastInboundMessageId: inboundId,
          lastMessageInputTokens: 1000,
          lastMessageOutputTokens: 100,
          ...stamp,
        }),
      );
      await new Promise((r) => setTimeout(r, 2));
      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [{ role: "assistant", content: [{ type: "text", text: "second" }] }],
          lastInboundMessageId: inboundId,
          lastMessageInputTokens: 2000,
          lastMessageOutputTokens: 200,
          ...stamp,
        }),
      );

      expect(await tx((trx) => store.getLastTokens(trx, conversationId))).toEqual({
        inputTokens: 2000,
        outputTokens: 200,
      });
    });

    it("insertMessage (singular) stores the -1 sentinel for outputTokens", async () => {
      // Singular insertMessage is used for the user row the orchestrator
      // writes up front — it has no output count, so the sentinel -1 is
      // stored. (The fast path only reads the last *assistant* row, so this
      // is never returned by getLastTokens — but we still prove it on disk.)
      const { conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "no tokens",
          lastInboundMessageId: inboundId,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );

      const rows = await db
        .select({ outputTokens: messages.outputTokens })
        .from(messages)
        .where(eq(messages.conversationId, conversationId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outputTokens).toBe(-1);

      // And getLastTokens still returns null — no assistant row exists.
      expect(await tx((trx) => store.getLastTokens(trx, conversationId))).toBeUndefined();
    });
  });

  describe("late replies", () => {
    // Inbound ids in arrival order: UUIDv7s compare as their bytes.
    const IN_1 = "019d0000-0000-7000-8000-000000000001";
    const IN_2 = "019d0000-0000-7000-8000-000000000002";
    const IN_3 = "019d0000-0000-7000-8000-000000000003";
    const IN_4 = "019d0000-0000-7000-8000-000000000004";

    /** A user row on `cursor`; `first` is the batch's first inbound on a turn row. */
    async function userRow(
      conversationId: string,
      stamp: { profileId: string; model: string },
      cursor: string,
      first: string | null,
      content: Message["content"],
    ): Promise<string> {
      const { id } = await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content,
          lastInboundMessageId: cursor,
          firstInboundMessageId: first,
          ...stamp,
        }),
      );
      return id;
    }

    function rebatched(conversationId: string, cursor: string): Promise<boolean> {
      return tx((trx) => store.isCursorRebatched(trx, conversationId, cursor));
    }

    it("insertMessage stores the batch's first inbound", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      const id = await userRow(conversationId, stamp, IN_2, IN_1, "words");

      const [row] = await db
        .select({ first: messages.firstInboundMessageId })
        .from(messages)
        .where(eq(messages.id, id));
      expect(row).toEqual({ first: IN_1 });
    });

    it("findLastAssistantMessageByInbound returns the newest assistant row on the cursor", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      await userRow(conversationId, stamp, IN_2, IN_1, "words");
      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [
            { role: "assistant", content: [{ type: "text", text: "first reply" }] },
            { role: "assistant", content: [{ type: "text", text: "final reply" }] },
          ],
          lastInboundMessageId: IN_2,
          lastMessageOutputTokens: 1,
          ...stamp,
        }),
      );
      const { id: duplicateFinal } = await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [{ role: "assistant", content: [{ type: "text", text: "rerun reply" }] }],
          lastInboundMessageId: IN_2,
          lastMessageOutputTokens: 1,
          ...stamp,
        }),
      );
      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [{ role: "assistant", content: [{ type: "text", text: "next turn" }] }],
          lastInboundMessageId: IN_3,
          lastMessageOutputTokens: 1,
          ...stamp,
        }),
      );

      expect(
        await tx((trx) => store.findLastAssistantMessageByInbound(trx, conversationId, IN_2)),
      ).toEqual({ id: duplicateFinal });
      expect(
        await tx((trx) => store.findLastAssistantMessageByInbound(trx, conversationId, IN_4)),
      ).toBeUndefined();
    });

    it("isCursorRebatched is false while no later turn row exists", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      // The turn's own row, and a duplicate from a re-run insert.
      await userRow(conversationId, stamp, IN_2, IN_1, "words");
      await userRow(conversationId, stamp, IN_2, IN_1, "words");

      expect(await rebatched(conversationId, IN_2)).toBe(false);
    });

    it("isCursorRebatched is true when a later turn row's batch holds the cursor", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      await userRow(conversationId, stamp, IN_2, IN_1, "words");
      await userRow(conversationId, stamp, IN_3, IN_1, "words");

      expect(await rebatched(conversationId, IN_2)).toBe(true);
      // The range start is inclusive: a batch starting at the cursor holds it.
      expect(await rebatched(conversationId, IN_1)).toBe(true);
    });

    it("isCursorRebatched is false for a later turn whose batch starts above the cursor", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      await userRow(conversationId, stamp, IN_2, IN_1, "words");
      await userRow(conversationId, stamp, IN_4, IN_3, "words");

      expect(await rebatched(conversationId, IN_2)).toBe(false);
    });

    it("isCursorRebatched counts a later turn row with no range start", async () => {
      // A turn row written before the column existed.
      const { conversationId, stamp } = await seedConversation(tx);
      await userRow(conversationId, stamp, IN_2, IN_1, "words");
      await userRow(conversationId, stamp, IN_3, null, "words");

      expect(await rebatched(conversationId, IN_2)).toBe(true);
    });

    it("isCursorRebatched ignores a later pipeline stage prompt", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      await db.insert(inboundMessages).values({
        id: IN_3,
        source: "pipeline",
        idempotencyKey: "pipeline:run-1:draft:0",
        conversationId,
        content: "stage prompt",
        platformTs: new Date(),
      });
      await userRow(conversationId, stamp, IN_2, IN_1, "words");
      await userRow(conversationId, stamp, IN_3, null, "stage prompt");

      expect(await rebatched(conversationId, IN_2)).toBe(false);
    });

    it("isCursorRebatched ignores later rows that are not turn rows", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      await userRow(conversationId, stamp, IN_2, IN_1, "words");
      await userRow(conversationId, stamp, IN_3, null, [
        { type: "tool_result", toolUseId: "t1", content: "out" },
      ]);
      await userRow(conversationId, stamp, IN_3, null, [
        { type: "text", text: "continue", harness: "continuation" },
      ]);
      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [{ role: "assistant", content: [{ type: "text", text: "reply" }] }],
          lastInboundMessageId: IN_3,
          lastMessageOutputTokens: 1,
          ...stamp,
        }),
      );

      expect(await rebatched(conversationId, IN_2)).toBe(false);
    });

    it("isCursorRebatched ignores another conversation's turn rows", async () => {
      const { userId, profileId, conversationId, stamp } = await seedConversation(tx);
      const other = await tx((trx) =>
        conversationStore.createConversation(trx, { userId, profileId, isPrivate: true }),
      );
      await userRow(conversationId, stamp, IN_2, IN_1, "words");
      await userRow(other.id, stamp, IN_3, IN_1, "words");

      expect(await rebatched(conversationId, IN_2)).toBe(false);
    });
  });

  describe("getLastMessageTime", () => {
    it("returns the most recent message timestamp", async () => {
      const { conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "hello",
          lastInboundMessageId: inboundId,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );

      const time = await tx((trx) => store.getLastMessageTime(trx, conversationId));
      expect(time).toBeInstanceOf(Date);
    });

    it("returns undefined for conversation with no messages", async () => {
      const { conversationId } = await seedConversation(tx);
      const time = await tx((trx) => store.getLastMessageTime(trx, conversationId));
      expect(time).toBeUndefined();
    });
  });
});

describe("conversation summaries", () => {
  const INBOUND = "019d0000-0000-7000-8000-0000000000ff";

  async function seedMessages(
    conversationId: string,
    stamp: { profileId: string; model: string },
    count: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const row = await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i}`,
          lastInboundMessageId: INBOUND,
          firstInboundMessageId: null,
          ...stamp,
        }),
      );
      ids.push(row.id);
    }
    return ids;
  }

  it("returns undefined before a conversation has ever been compacted", async () => {
    const { conversationId } = await seedConversation(tx);
    await expect(tx((trx) => store.getLatestSummary(trx, conversationId))).resolves.toBeUndefined();
  });

  it("returns the newest summary when several have been appended", async () => {
    const { conversationId, stamp } = await seedConversation(tx);
    const ids = await seedMessages(conversationId, stamp, 4);

    await tx((trx) =>
      store.insertOrRecoverSummary(trx, {
        conversationId,
        summary: "first pass",
        throughMessageId: expectDefined(ids[0]),
        messagesSummarized: 1,
        model: "claude-haiku-4-5",
        source: "turn",
      }),
    );
    await tx((trx) =>
      store.insertOrRecoverSummary(trx, {
        conversationId,
        summary: "second pass",
        throughMessageId: expectDefined(ids[2]),
        messagesSummarized: 3,
        model: "claude-haiku-4-5",
        source: "manual",
      }),
    );

    const latest = expectDefined(await tx((trx) => store.getLatestSummary(trx, conversationId)));
    expect(latest.summary).toBe("second pass");
    expect(latest.throughMessageId).toBe(ids[2]);
    expect(latest.messagesSummarized).toBe(3);
    expect(latest.source).toBe("manual");
  });

  it("returns the widest summary even when a narrower one was inserted later", async () => {
    // The discriminating case: insertion order and coverage order disagree.
    // Ordering by `id` would return the narrower row here and orphan the wider
    // one, silently re-including messages it already covers.
    const { conversationId, stamp } = await seedConversation(tx);
    const ids = await seedMessages(conversationId, stamp, 4);

    await tx((trx) =>
      store.insertOrRecoverSummary(trx, {
        conversationId,
        summary: "wider, written first",
        throughMessageId: expectDefined(ids[2]),
        messagesSummarized: 3,
        model: "claude-haiku-4-5",
        source: "turn",
      }),
    );
    await tx((trx) =>
      store.insertOrRecoverSummary(trx, {
        conversationId,
        summary: "narrower, written second",
        throughMessageId: expectDefined(ids[0]),
        messagesSummarized: 1,
        model: "claude-haiku-4-5",
        source: "manual",
      }),
    );

    const latest = expectDefined(await tx((trx) => store.getLatestSummary(trx, conversationId)));
    expect(latest.summary).toBe("wider, written first");
    expect(latest.throughMessageId).toBe(ids[2]);
  });

  it("scopes the latest-summary read to its own conversation", async () => {
    const { userId, profileId, conversationId, stamp } = await seedConversation(tx);
    const other = (
      await tx((trx) =>
        conversationStore.createConversation(trx, { userId, profileId, isPrivate: true }),
      )
    ).id;
    const ids = await seedMessages(conversationId, stamp, 2);

    await tx((trx) =>
      store.insertOrRecoverSummary(trx, {
        conversationId,
        summary: "belongs to the first",
        throughMessageId: expectDefined(ids[0]),
        messagesSummarized: 1,
        model: "claude-haiku-4-5",
        source: "turn",
      }),
    );

    await expect(tx((trx) => store.getLatestSummary(trx, other))).resolves.toBeUndefined();
  });

  it("recovers the existing row when the same cutoff is written twice", async () => {
    const { conversationId, stamp } = await seedConversation(tx);
    const ids = await seedMessages(conversationId, stamp, 2);
    const params = {
      conversationId,
      summary: "written once",
      throughMessageId: expectDefined(ids[0]),
      messagesSummarized: 1,
      model: "claude-haiku-4-5",
      source: "turn" as const,
    };

    const first = await tx((trx) => store.insertOrRecoverSummary(trx, params));
    const second = await tx((trx) =>
      store.insertOrRecoverSummary(trx, { ...params, summary: "a retry's text" }),
    );

    expect(first.kind).toBe("new");
    expect(second.kind).toBe("recovered");
    expect(second.row.id).toBe(first.row.id);
    // The conflict arm is a no-op SET, so a retry can't rewrite a committed
    // summary — the stored text stays whatever the winning insert wrote.
    expect(second.row.summary).toBe("written once");

    const rows = await tx((trx) =>
      trx
        .select()
        .from(conversationSummaries)
        .where(eq(conversationSummaries.conversationId, conversationId)),
    );
    expect(rows).toHaveLength(1);
  });

  it("lets the same cutoff be reused across different conversations", async () => {
    const { userId, profileId, conversationId, stamp } = await seedConversation(tx);
    const other = (
      await tx((trx) =>
        conversationStore.createConversation(trx, { userId, profileId, isPrivate: true }),
      )
    ).id;
    const ids = await seedMessages(conversationId, stamp, 1);
    const otherIds = await seedMessages(other, stamp, 1);

    const first = await tx((trx) =>
      store.insertOrRecoverSummary(trx, {
        conversationId,
        summary: "a",
        throughMessageId: expectDefined(ids[0]),
        messagesSummarized: 1,
        model: "claude-haiku-4-5",
        source: "turn",
      }),
    );
    const second = await tx((trx) =>
      store.insertOrRecoverSummary(trx, {
        conversationId: other,
        summary: "b",
        throughMessageId: expectDefined(otherIds[0]),
        messagesSummarized: 1,
        model: "claude-haiku-4-5",
        source: "turn",
      }),
    );

    expect(first.kind).toBe("new");
    expect(second.kind).toBe("new");
  });

  it("returns only messages after the cutoff, in order, with their ids", async () => {
    const { conversationId, stamp } = await seedConversation(tx);
    const ids = await seedMessages(conversationId, stamp, 5);

    const after = await tx((trx) =>
      store.getHistoryAfter(trx, conversationId, expectDefined(ids[1])),
    );

    expect(after.map((m) => m.id)).toEqual(ids.slice(2));
    expect(after.map((m) => m.content)).toEqual(["m2", "m3", "m4"]);
  });

  it("returns nothing when the cutoff is the newest message", async () => {
    const { conversationId, stamp } = await seedConversation(tx);
    const ids = await seedMessages(conversationId, stamp, 3);

    const after = await tx((trx) =>
      store.getHistoryAfter(trx, conversationId, expectDefined(ids[2])),
    );

    expect(after).toEqual([]);
  });

  it("excludes another conversation's messages from the after-cutoff read", async () => {
    const { userId, profileId, conversationId, stamp } = await seedConversation(tx);
    const other = (
      await tx((trx) =>
        conversationStore.createConversation(trx, { userId, profileId, isPrivate: true }),
      )
    ).id;
    const ids = await seedMessages(conversationId, stamp, 2);
    await seedMessages(other, stamp, 2);

    const after = await tx((trx) =>
      store.getHistoryAfter(trx, conversationId, expectDefined(ids[0])),
    );

    expect(after.map((m) => m.id)).toEqual([ids[1]]);
  });
});

describe("turn contexts", () => {
  const INBOUND = "019d0000-0000-7000-8000-0000000000fe";
  const CONTEXT = {
    recalledMemories: ["runs Proxmox"],
    voiceMode: false,
    channelTypes: [],
    announcedCoreMemoryBlocks: [
      { profileClass: null, key: "identity", updatedAt: "2026-09-27T10:01:00.000Z" },
    ],
  };

  async function seedUserRow() {
    const seeded = await seedConversation(tx);
    return { ...seeded, row: await insertUserRow(seeded.conversationId, seeded.stamp) };
  }

  /** A user row on `INBOUND`, with the `created_at` the database gave it. */
  async function insertUserRow(
    conversationId: string,
    stamp: { profileId: string; model: string },
  ): Promise<{ id: string; createdAt: Date }> {
    const { id } = await tx((trx) =>
      store.insertMessage(trx, {
        conversationId,
        role: "user",
        content: "hello",
        lastInboundMessageId: INBOUND,
        firstInboundMessageId: null,
        ...stamp,
      }),
    );
    const [row] = await tx((trx) =>
      trx
        .select({ id: messages.id, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.id, id)),
    );
    return expectDefined(row, "inserted user row");
  }

  it("stores a turn context and lists it by message", async () => {
    const { conversationId, row } = await seedUserRow();

    const stored = await tx((trx) =>
      store.insertOrRecoverTurnContext(trx, {
        messageId: row.id,
        rendered: "<turn_context>first</turn_context>\n\n",
        context: CONTEXT,
      }),
    );

    expect(stored).toEqual({
      messageId: row.id,
      rendered: "<turn_context>first</turn_context>\n\n",
      context: CONTEXT,
    });
    await expect(tx((trx) => store.listTurnContexts(trx, conversationId, null))).resolves.toEqual([
      stored,
    ]);
  });

  it("recovers the stored text when the same message is written twice", async () => {
    const { conversationId, row } = await seedUserRow();
    const first = await tx((trx) =>
      store.insertOrRecoverTurnContext(trx, {
        messageId: row.id,
        rendered: "first attempt",
        context: CONTEXT,
      }),
    );

    const retry = await tx((trx) =>
      store.insertOrRecoverTurnContext(trx, {
        messageId: row.id,
        rendered: "a retry rendered at another minute",
        context: { ...CONTEXT, recalledMemories: [] },
      }),
    );

    expect(retry).toEqual(first);
    const rows = await tx((trx) => store.listTurnContexts(trx, conversationId, null));
    expect(rows).toHaveLength(1);
  });

  it("lists a conversation's turn contexts after the cutoff, and no other conversation's", async () => {
    const { userId, profileId, conversationId, stamp, row: a } = await seedUserRow();
    // A reply in between, which has no turn context.
    const reply = await tx((trx) =>
      store.insertMessage(trx, {
        conversationId,
        role: "assistant",
        content: "reply",
        lastInboundMessageId: INBOUND,
        firstInboundMessageId: null,
        ...stamp,
      }),
    );
    const b = await insertUserRow(conversationId, stamp);
    const other = (
      await tx((trx) =>
        conversationStore.createConversation(trx, { userId, profileId, isPrivate: true }),
      )
    ).id;
    const c = await insertUserRow(other, stamp);
    for (const row of [a, b, c]) {
      await tx((trx) =>
        store.insertOrRecoverTurnContext(trx, {
          messageId: row.id,
          rendered: row.id,
          context: CONTEXT,
        }),
      );
    }

    async function listed(conversation: string, afterMessageId: string | null) {
      const rows = await tx((trx) => store.listTurnContexts(trx, conversation, afterMessageId));
      return rows.map((r) => r.messageId).toSorted();
    }
    expect(await listed(conversationId, null)).toEqual([a.id, b.id].toSorted());
    // The cutoff is exclusive, as `getHistoryAfter`'s is.
    expect(await listed(conversationId, a.id)).toEqual([b.id]);
    expect(await listed(conversationId, reply.id)).toEqual([b.id]);
    expect(await listed(conversationId, b.id)).toEqual([]);
    expect(await listed(other, null)).toEqual([c.id]);
  });

  it("refuses a context for a message that doesn't exist", async () => {
    await expect(
      tx((trx) =>
        store.insertOrRecoverTurnContext(trx, {
          messageId: "019d0000-0000-7000-8000-000000000999",
          rendered: "orphan",
          context: CONTEXT,
        }),
      ),
    ).rejects.toThrow();
  });

  it("validates the context at the store boundary, on write and on read", async () => {
    const { conversationId, row } = await seedUserRow();
    await expect(
      tx((trx) =>
        store.insertOrRecoverTurnContext(trx, {
          messageId: row.id,
          rendered: "bad",
          context: { recalledMemories: "not a list" } as never,
        }),
      ),
    ).rejects.toThrow();

    // A row written behind the store's back fails when read.
    await db.execute(
      sql`INSERT INTO turn_contexts (message_id, rendered, context) VALUES (${row.id}, 'raw', '{"voiceMode": "yes"}'::jsonb)`,
    );
    await expect(tx((trx) => store.listTurnContexts(trx, conversationId, null))).rejects.toThrow();
  });

  it("reads a row that announced nothing, as every row before versioned announcements did", async () => {
    const { conversationId, row } = await seedUserRow();
    await db.execute(
      sql`INSERT INTO turn_contexts (message_id, rendered, context) VALUES (${row.id}, 'raw', '{"recalledMemories": [], "voiceMode": false, "channelTypes": [], "announcedCoreMemoryBlocks": []}'::jsonb)`,
    );

    const [stored] = await tx((trx) => store.listTurnContexts(trx, conversationId, null));
    expect(stored?.context.announcedCoreMemoryBlocks).toEqual([]);
  });

  it("finds a turn's user row by its inbound, not a later tool result, in its own conversation", async () => {
    const { userId, profileId, conversationId, stamp, row } = await seedUserRow();
    // The turn's reply and its tool results cursor on the same inbound, the
    // tool results as later user rows, and must not be the one found.
    await tx((trx) =>
      store.insertMessages(trx, {
        conversationId,
        lastInboundMessageId: INBOUND,
        ...stamp,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "web_search", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "t1", content: "search result" }],
          },
          { role: "assistant", content: "reply" },
        ],
        lastMessageOutputTokens: 12,
      }),
    );
    // Another conversation's row on the same cursor stays out of it.
    const other = (
      await tx((trx) =>
        conversationStore.createConversation(trx, { userId, profileId, isPrivate: true }),
      )
    ).id;
    const otherRow = await insertUserRow(other, stamp);

    await expect(
      tx((trx) => store.findUserMessageByInbound(trx, conversationId, INBOUND)),
    ).resolves.toEqual({ id: row.id, createdAt: row.createdAt });
    await expect(tx((trx) => store.findUserMessageByInbound(trx, other, INBOUND))).resolves.toEqual(
      { id: otherRow.id, createdAt: otherRow.createdAt },
    );
    await expect(
      tx((trx) =>
        store.findUserMessageByInbound(trx, conversationId, "019d0000-0000-7000-8000-000000000999"),
      ),
    ).resolves.toBeUndefined();
  });

  it("finds the newer of two user rows on one inbound", async () => {
    // A re-run insert leaves two; the turn that wrote the second is the one
    // looking.
    const { conversationId, stamp } = await seedUserRow();
    const second = await insertUserRow(conversationId, stamp);

    await expect(
      tx((trx) => store.findUserMessageByInbound(trx, conversationId, INBOUND)),
    ).resolves.toEqual({ id: second.id, createdAt: second.createdAt });
  });

  it("finds the turn row past a later continuation prompt and nudge on its cursor", async () => {
    const { conversationId, stamp, row } = await seedUserRow();
    await tx((trx) =>
      store.insertMessages(trx, {
        conversationId,
        lastInboundMessageId: INBOUND,
        ...stamp,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Please complete your response.", harness: "continuation" },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "img", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "t1", content: "stop", harness: "volume_nudge" },
            ],
          },
          { role: "assistant", content: "reply" },
        ],
        lastMessageOutputTokens: 12,
      }),
    );

    await expect(
      tx((trx) => store.findUserMessageByInbound(trx, conversationId, INBOUND)),
    ).resolves.toEqual({ id: row.id, createdAt: row.createdAt });
  });

  it("finds a turn row whose content is a block array without a harness tag", async () => {
    const { conversationId, stamp } = await seedUserRow();
    const { id } = await tx((trx) =>
      store.insertMessage(trx, {
        conversationId,
        role: "user",
        content: [{ type: "text", text: "look at this" }],
        lastInboundMessageId: INBOUND,
        firstInboundMessageId: null,
        ...stamp,
      }),
    );

    const found = await tx((trx) => store.findUserMessageByInbound(trx, conversationId, INBOUND));
    expect(found?.id).toBe(id);
  });

  it.each(HARNESS_ROW_TAGS)("skips a later user row carrying a %s block", async (tag) => {
    const { conversationId, stamp, row } = await seedUserRow();
    await tx((trx) =>
      store.insertMessage(trx, {
        conversationId,
        role: "user",
        content: [{ type: "text", text: "x", harness: tag }],
        lastInboundMessageId: INBOUND,
        firstInboundMessageId: null,
        ...stamp,
      }),
    );

    const found = await tx((trx) => store.findUserMessageByInbound(trx, conversationId, INBOUND));
    expect(found?.id).toBe(row.id);
  });
});

describe("system prompt snapshots", () => {
  async function userRow(conversationId: string, stamp: { profileId: string; model: string }) {
    return (
      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "hello",
          lastInboundMessageId: "019d0000-0000-7000-8000-0000000000fe",
          firstInboundMessageId: null,
          ...stamp,
        }),
      )
    ).id;
  }

  function snapshot(conversationId: string, openedBy: string, rendered: string) {
    return {
      conversationId,
      openedBy,
      historyStart: openedBy,
      rendered,
      configDigest: `digest of ${rendered}`,
    };
  }

  it("stores the snapshot a turn opens and reads it back as the conversation's latest", async () => {
    const { conversationId, stamp } = await seedConversation(tx);
    const opener = await userRow(conversationId, stamp);

    const row = await tx((trx) =>
      store.insertOrRecoverSystemPromptSnapshot(trx, snapshot(conversationId, opener, "first")),
    );

    expect(row).toMatchObject(snapshot(conversationId, opener, "first"));
    expect(row.createdAt).toBeInstanceOf(Date);
    await expect(
      tx((trx) => store.getLatestSystemPromptSnapshot(trx, conversationId)),
    ).resolves.toEqual(row);
  });

  it("recovers the stored row when the same turn opens an epoch twice", async () => {
    const { conversationId, stamp } = await seedConversation(tx);
    const opener = await userRow(conversationId, stamp);
    const first = await tx((trx) =>
      store.insertOrRecoverSystemPromptSnapshot(trx, snapshot(conversationId, opener, "first")),
    );

    const retry = await tx((trx) =>
      store.insertOrRecoverSystemPromptSnapshot(trx, snapshot(conversationId, opener, "retry")),
    );

    expect(retry).toEqual(first);
    const rows = await db.select().from(systemPromptSnapshots);
    expect(rows).toHaveLength(1);
  });

  it("returns the epoch opened latest in the transcript, and only the conversation's own", async () => {
    const { userId, profileId, conversationId, stamp } = await seedConversation(tx);
    const earlier = await userRow(conversationId, stamp);
    const later = await userRow(conversationId, stamp);
    const other = (
      await tx((trx) =>
        conversationStore.createConversation(trx, { userId, profileId, isPrivate: true }),
      )
    ).id;
    const otherRow = await userRow(other, stamp);
    // Inserted out of transcript order.
    for (const [conversation, opener, text] of [
      [conversationId, later, "later"],
      [conversationId, earlier, "earlier"],
      [other, otherRow, "other"],
    ] as const) {
      await tx((trx) =>
        store.insertOrRecoverSystemPromptSnapshot(trx, snapshot(conversation, opener, text)),
      );
    }

    const latest = await tx((trx) => store.getLatestSystemPromptSnapshot(trx, conversationId));
    expect(latest?.rendered).toBe("later");
    const none = (
      await tx((trx) =>
        conversationStore.createConversation(trx, { userId, profileId, isPrivate: true }),
      )
    ).id;
    await expect(
      tx((trx) => store.getLatestSystemPromptSnapshot(trx, none)),
    ).resolves.toBeUndefined();
  });

  it("refuses a snapshot opened by a message that doesn't exist", async () => {
    const { conversationId } = await seedConversation(tx);
    await expect(
      tx((trx) =>
        store.insertOrRecoverSystemPromptSnapshot(
          trx,
          snapshot(conversationId, "019d0000-0000-7000-8000-000000000999", "orphan"),
        ),
      ),
    ).rejects.toThrow();
  });
});
