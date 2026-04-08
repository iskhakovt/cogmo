import { inngest } from "../inngest/client.js";
import { inboundArrived, responseReady } from "../inngest/events.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ContentBlock, Message, StreamEvent } from "../llm/types.js";
import { logger } from "../logger.js";
import type { MemoryProvider } from "../memory/provider.js";
import { contentToBlocks, contentToText } from "../transport/content.js";
import type { DeliveryRouter } from "../transport/delivery-router.js";
import type { TransportStore } from "../transport/store/index.js";
import type { AgentLoopResult, StreamingAgentLoopParams } from "./loop.js";
import type { PromptSource } from "./prompt.js";
import type { Service } from "./service.js";
import { createService } from "./service.js";
import type { AgentStore } from "./store/index.js";
import type { ToolRegistry } from "./tools.js";

export interface HandleMessageDeps {
  agentStore: AgentStore;
  transportStore: TransportStore;
  provider: LlmProvider;
  tools: ToolRegistry;
  memory: MemoryProvider;
  promptSource: PromptSource;
  fileService: Service["files"];
  deliveryRouter: DeliveryRouter;
  runStreamingAgentLoop: (params: StreamingAgentLoopParams) => Promise<AgentLoopResult>;
}

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/**
 * Main message pipeline — thin orchestration only.
 *
 * Receives inbound/arrived events (adapter has already persisted the inbound
 * message and resolved the session). Loads context, streams the agent response
 * to streaming adapters, persists, delivers to batch adapters, emits notification.
 */
export function createHandleMessage(deps: HandleMessageDeps) {
  const {
    agentStore,
    transportStore,
    provider,
    tools,
    memory,
    promptSource,
    fileService,
    deliveryRouter,
    runStreamingAgentLoop,
  } = deps;

  return inngest.createFunction(
    {
      id: "handle-message",
      triggers: [inboundArrived],
      retries: 2,
      concurrency: { limit: 1, key: "event.data.conversationId" },
    },
    async ({ event, step, runId }) => {
      const { conversationId, inboundMessageId } = event.data;

      // ──── DURABLE: load context ────

      const conv = await step.run("load-conversation", async () => {
        return agentStore.getConversation(conversationId);
      });
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

      const { userId, profileId } = conv;

      const lastAssistant = await step.run("last-assistant", async () => {
        return agentStore.getLastAssistantMessage(conversationId);
      });

      const inboundMessages = await step.run("load-inbound", async () => {
        return transportStore.getUnbatchedInbound(
          conversationId,
          lastAssistant?.lastInboundMessageId ?? null,
        );
      });

      const inboundBlocks = inboundMessages.flatMap((m) => contentToBlocks(m.content));
      const userContentText = inboundMessages.map((m) => contentToText(m.content)).join("\n");
      const maxInboundId = inboundMessages.at(-1)?.id ?? inboundMessageId;

      await step.run("create-user-message", async () => {
        await agentStore.insertMessage({
          conversationId,
          role: "user",
          content: userContentText,
          lastInboundMessageId: maxInboundId,
        });
      });

      const history = await step.run("load-history", async () => {
        return agentStore.getHistory(conversationId);
      });

      const systemPrompt = await step.run("assemble-prompt", async () => {
        return promptSource.assemble(agentStore, profileId);
      });

      // ──── NON-DURABLE: resolve images + auto-recall + stream ────

      // Resolve ImageRefs from S3 into actual ImageBlocks
      const resolvedBlocks: ContentBlock[] = await Promise.all(
        inboundBlocks.map(async (block): Promise<ContentBlock> => {
          if (block.type === "image_ref") {
            const data = await fileService.read(block.path);
            return { type: "image", source: "base64", data, mediaType: block.mediaType };
          }
          return block;
        }),
      );

      // Auto-recall: search memory for context relevant to this message
      const recallResult = await memory.recall(userId, userContentText, { maxTokens: 2000 });
      const recalledContext =
        recallResult.memories.length > 0
          ? recallResult.memories.map((m) => m.content).join("\n")
          : null;

      // Build scoped service for this turn
      const coreMemoryService: Service["coreMemory"] = {
        get: () => agentStore.getCoreMemoryBlocks(userId),
        update: (key, content) => agentStore.upsertCoreMemoryBlock({ userId, key, content }),
      };

      const profile = await agentStore.getProfile(profileId);
      const service = createService(memory, userId, [], fileService, coreMemoryService);
      const delivery = await deliveryRouter.prepare(conversationId, runId);

      // Append recalled context to system prompt
      const fullPrompt = recalledContext
        ? `${systemPrompt}\n\n# Recalled Context\n\n${recalledContext}`
        : systemPrompt;

      // Build message history, replacing the last user message with resolved content
      const historyMessages = [...history] as Message[];
      const hasImages = resolvedBlocks.some((b) => b.type === "image");
      if (hasImages && historyMessages.length > 0) {
        // Replace the last user message (just persisted as text) with full content blocks
        const lastIdx = historyMessages.length - 1;
        if (historyMessages[lastIdx]?.role === "user") {
          historyMessages[lastIdx] = { role: "user", content: resolvedBlocks };
        }
      }

      let result: AgentLoopResult;
      try {
        result = await runStreamingAgentLoop({
          provider,
          model: profile?.model ?? DEFAULT_MODEL,
          systemPrompt: fullPrompt,
          messages: historyMessages,
          tools,
          service,
          onEvent: (event: StreamEvent) => delivery.push(event),
        });
        await delivery.finish();
      } catch (err) {
        await delivery.abort(err instanceof Error ? err.message : "Unknown error");
        throw err;
      }

      logger.info(
        {
          conversationId,
          model: result.model,
          iterations: result.iterations,
          usage: result.usage,
        },
        "agent loop complete",
      );

      // ──── DURABLE: persist ────

      const assistantMsg = await step.run("persist-assistant-message", async () => {
        return agentStore.insertMessage({
          conversationId,
          role: "assistant",
          content: result.text,
          lastInboundMessageId: maxInboundId,
        });
      });

      // ──── NON-DURABLE: batch delivery ────

      await delivery.deliverBatch(result.text);

      // ──── DURABLE: notify (Observer, metrics — not delivery) ────

      await step.sendEvent(
        "send-response",
        responseReady.create({
          conversationId,
          messageId: assistantMsg.id,
        }),
      );
    },
  );
}
