import { eq } from "drizzle-orm";
import type { AgentLoopResult } from "../../agent/loop.js";
import type { ToolRegistry } from "../../agent/tools.js";
import { single } from "../../db/helpers.js";
import type { Database } from "../../db/index.js";
import {
  chats,
  conversations,
  deliveries,
  inboundMessages,
  messages as messagesTable,
} from "../../db/schema.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { Message } from "../../llm/types.js";
import { logger } from "../../logger.js";
import { inngest } from "../client.js";
import { messageReceived, messageResponse } from "../events.js";

export interface HandleMessageDeps {
  db: Database;
  provider: LlmProvider;
  tools: ToolRegistry;
  assembleSystemPrompt: (db: Database, profileId: string) => Promise<string>;
  runAgentLoop: (params: {
    provider: LlmProvider;
    model: string;
    systemPrompt: string;
    messages: Message[];
    tools: ToolRegistry;
  }) => Promise<AgentLoopResult>;
  defaultProfileId: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/**
 * Main message pipeline — thin orchestration only.
 *
 * Receives message/received events, delegates to domain services,
 * emits message/response when done. Never touches channel adapters.
 */
export function createHandleMessage(deps: HandleMessageDeps) {
  const { db, provider, tools, assembleSystemPrompt, runAgentLoop, defaultProfileId } = deps;

  return inngest.createFunction(
    {
      id: "handle-message",
      triggers: [messageReceived],
      retries: 2,
      concurrency: { limit: 1, key: "event.data.chatId" },
    },
    async ({ event, step }) => {
      const { channel, chatId, userId, text } = event.data;

      // Step 1: Persist inbound message immediately (durability)
      const { inboundId, chatRowId } = await step.run("persist-inbound", async () => {
        return db.transaction(async (tx) => {
          // Find or create chat
          const existingChat = await tx
            .select({ id: chats.id })
            .from(chats)
            .where(eq(chats.address, { channel, chatId }))
            .limit(1);

          let chatRowId: string;
          if (existingChat[0]) {
            chatRowId = existingChat[0].id;
          } else {
            chatRowId = single(
              await tx
                .insert(chats)
                .values({ address: { channel, chatId }, userId })
                .returning({ id: chats.id }),
            ).id;
          }

          // Persist inbound message
          const inbound = single(
            await tx
              .insert(inboundMessages)
              .values({ chatId: chatRowId, content: text })
              .returning({ id: inboundMessages.id }),
          );

          return { inboundId: inbound.id, chatRowId };
        });
      });

      // Step 2: Resolve conversation (find active or create)
      const { conversationId, profileId } = await step.run("resolve-session", async () => {
        return db.transaction(async (tx) => {
          // Check if chat has an active conversation
          const chat = await tx
            .select({ conversationId: chats.conversationId })
            .from(chats)
            .where(eq(chats.id, chatRowId))
            .limit(1);

          let conversationId = chat[0]?.conversationId;

          if (!conversationId) {
            // Create new conversation and link chat
            const newConv = single(
              await tx
                .insert(conversations)
                .values({ userId, profileId: defaultProfileId })
                .returning({ id: conversations.id }),
            );
            conversationId = newConv.id;

            await tx.update(chats).set({ conversationId }).where(eq(chats.id, chatRowId));
          }

          // Get profile from conversation
          const conv = single(
            await tx
              .select({ profileId: conversations.profileId })
              .from(conversations)
              .where(eq(conversations.id, conversationId))
              .limit(1),
          );

          return { conversationId, profileId: conv.profileId };
        });
      });

      // Step 3: Create conversation message from inbound + delivery record
      await step.run("create-user-message", async () => {
        return db.transaction(async (tx) => {
          const msg = single(
            await tx
              .insert(messagesTable)
              .values({ conversationId, role: "user", content: text })
              .returning({ id: messagesTable.id }),
          );

          // Link inbound to conversation message
          await tx
            .update(inboundMessages)
            .set({ status: "processed", messageId: msg.id })
            .where(eq(inboundMessages.id, inboundId));

          // Record delivery
          await tx.insert(deliveries).values({
            messageId: msg.id,
            chatId: chatRowId,
            direction: "inbound",
            status: "delivered",
          });
        });
      });

      // Step 4: Load conversation history
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

      // Step 5: Assemble system prompt
      const systemPrompt = await step.run("assemble-prompt", async () => {
        return assembleSystemPrompt(db, profileId);
      });

      // Step 6: Run the agentic loop
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

      // Step 7: Persist assistant response
      await step.run("persist-assistant-message", async () => {
        await db.insert(messagesTable).values({
          conversationId,
          role: "assistant",
          content: result.text,
        });
      });

      // Step 8: Emit response event — channel adapters handle delivery
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
