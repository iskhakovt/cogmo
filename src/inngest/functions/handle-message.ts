import { eq } from "drizzle-orm";
import type { AgentLoopResult } from "../../agent/loop.js";
import type { ToolRegistry } from "../../agent/tools.js";
import type { Database } from "../../db/index.js";
import { conversations, messages as messagesTable } from "../../db/schema.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { Message } from "../../llm/types.js";
import { logger } from "../../logger.js";
import { inngest } from "../client.js";
import { messageReceived, messageResponse } from "../events.js";

export interface HandleMessageDeps {
  db: Database;
  provider: LlmProvider;
  tools: ToolRegistry;
  assembleSystemPrompt: (db: Database) => Promise<string>;
  runAgentLoop: (params: {
    provider: LlmProvider;
    model: string;
    systemPrompt: string;
    messages: Message[];
    tools: ToolRegistry;
  }) => Promise<AgentLoopResult>;
}

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/**
 * Main message pipeline — thin orchestration only.
 *
 * Receives message/received events, delegates to domain services,
 * emits message/response when done. Never touches channel adapters.
 */
export function createHandleMessage(deps: HandleMessageDeps) {
  const { db, provider, tools, assembleSystemPrompt, runAgentLoop } = deps;

  return inngest.createFunction(
    {
      id: "handle-message",
      triggers: [messageReceived],
      retries: 2,
      concurrency: { limit: 3, key: "event.data.conversationId" },
    },
    async ({ event, step }) => {
      const { conversationId, channel, chatId, userId, text } = event.data;

      // Step 1: Ensure conversation exists
      await step.run("ensure-conversation", async () => {
        const existing = await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .limit(1);

        if (existing[0]) {
          await db
            .update(conversations)
            .set({ lastMessageAt: new Date() })
            .where(eq(conversations.id, conversationId));
          return existing[0];
        }

        const now = new Date();
        const newConv = {
          id: conversationId,
          channel,
          userId,
          startedAt: now,
          lastMessageAt: now,
        };
        await db.insert(conversations).values(newConv);
        return newConv;
      });

      // Step 2: Persist incoming user message
      await step.run("persist-user-message", async () => {
        await db.insert(messagesTable).values({
          conversationId,
          role: "user",
          content: text,
          createdAt: new Date(),
        });
      });

      // Step 3: Load conversation history
      const history = await step.run("load-history", async () => {
        const rows = await db
          .select({ role: messagesTable.role, content: messagesTable.content })
          .from(messagesTable)
          .where(eq(messagesTable.conversationId, conversationId))
          .orderBy(messagesTable.createdAt);

        return rows.map((r) => ({
          role: r.role as "user" | "assistant",
          content: r.content,
        }));
      });

      // Step 4: Assemble system prompt
      const systemPrompt = await step.run("assemble-prompt", async () => {
        return assembleSystemPrompt(db);
      });

      // Step 5: Run the agentic loop
      const result = await step.run("agent-loop", async () => {
        return runAgentLoop({
          provider,
          model: DEFAULT_MODEL,
          systemPrompt,
          messages: history as Message[],
          tools,
        });
      });

      logger.info(
        {
          conversationId,
          model: result.model,
          iterations: result.iterations,
          usage: result.usage,
        },
        "agent loop complete",
      );

      // Step 6: Persist assistant response
      await step.run("persist-assistant-message", async () => {
        await db.insert(messagesTable).values({
          conversationId,
          role: "assistant",
          content: result.text,
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          createdAt: new Date(),
        });
      });

      // Step 7: Emit response event — channel adapters handle delivery
      await step.sendEvent(
        "send-response",
        messageResponse.create({
          conversationId,
          channel,
          chatId,
          text: result.text,
        }),
      );
    },
  );
}
