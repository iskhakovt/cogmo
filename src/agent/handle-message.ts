import { inngest } from "../inngest/client.js";
import { inboundReady, responseReady } from "../inngest/events.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ContentBlock, Message, StreamEvent } from "../llm/types.js";
import { logger } from "../logger.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { contentToBlocks, contentToText } from "../transport/content.js";
import type { DeliveryRouter } from "../transport/delivery-router.js";
import type { TransportStore } from "../transport/store/index.js";
import type { DebounceConfig } from "./debounce.js";
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
  attachments: AttachmentStore;
  debounceConfig: DebounceConfig;
  deliveryRouter: DeliveryRouter;
  runStreamingAgentLoop: (params: StreamingAgentLoopParams) => Promise<AgentLoopResult>;
}

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/**
 * Main message pipeline — thin orchestration only.
 *
 * Receives inbound/ready events (debounce router has decided it's time to process).
 * Loads context, streams the agent response to streaming adapters, persists,
 * delivers to batch adapters, emits notification, applies resume policy.
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
    attachments,
    debounceConfig,
    deliveryRouter,
    runStreamingAgentLoop,
  } = deps;

  return inngest.createFunction(
    {
      id: "handle-message",
      triggers: [inboundReady],
      retries: 2,
      concurrency: { limit: 1, key: "event.data.conversationId" },
    },
    async ({ event, step, runId }) => {
      const { conversationId, triggerInboundId } = event.data;

      // ──── DURABLE: load context + entry guards ────

      const conv = await step.run("load-conversation", async () => {
        return agentStore.getConversation(conversationId);
      });
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

      const { userId, profileId } = conv;

      const lastAssistant = await step.run("last-assistant", async () => {
        return agentStore.getLastAssistantMessage(conversationId);
      });

      // Guard 1 — Staleness: trigger was already batched into a previous turn.
      // null trigger = flush, skip this check.
      if (
        triggerInboundId !== null &&
        lastAssistant?.lastInboundMessageId &&
        triggerInboundId <= lastAssistant.lastInboundMessageId
      ) {
        return { status: "skipped", reason: "stale" };
      }

      // Guard 2 — Await_input: trigger was created before the last response.
      if (
        debounceConfig.resumePolicy === "await_input" &&
        triggerInboundId !== null &&
        lastAssistant &&
        triggerInboundId < lastAssistant.id
      ) {
        return { status: "skipped", reason: "await_input" };
      }

      const inboundMessages = await step.run("load-inbound", async () => {
        return transportStore.getUnbatchedInbound(
          conversationId,
          lastAssistant?.lastInboundMessageId ?? null,
        );
      });

      const inboundBlocks = inboundMessages.flatMap((m) => contentToBlocks(m.content));
      const userContentText = inboundMessages.map((m) => contentToText(m.content)).join("\n");
      const maxInboundId = inboundMessages.at(-1)?.id ?? triggerInboundId ?? "";

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

      // Resolve ImageRefs from S3 into actual ImageBlocks (read bytes, base64-encode)
      const resolvedBlocks: ContentBlock[] = await Promise.all(
        inboundBlocks.map(async (block): Promise<ContentBlock> => {
          if (block.type === "image_ref") {
            const bytes = await attachments.download(block.path);
            return {
              type: "image",
              source: "base64",
              data: bytes.toString("base64"),
              mediaType: block.mediaType,
            };
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

      // Build message history, replacing the last user message with resolved content.
      // Safe because: getHistory runs after create-user-message (durable step ordering),
      // and concurrency lock on conversationId prevents concurrent writes.
      const historyMessages = [...history] as Message[];
      const hasImages = resolvedBlocks.some((b) => b.type === "image");
      if (hasImages && historyMessages.length > 0) {
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

      // ──── RESUME POLICY ────

      if (debounceConfig.resumePolicy === "flush") {
        // Process any remaining unbatched messages immediately (no debounce wait)
        await step.sendEvent(
          "flush",
          inboundReady.create({ conversationId, triggerInboundId: null }),
        );
      }
      // "debounce": queued inbound/ready events fire naturally when concurrency lock releases
      // "await_input": guard 2 catches all buffered events; new input triggers fresh debounce

      return { status: "processed", conversationId };
    },
  );
}
